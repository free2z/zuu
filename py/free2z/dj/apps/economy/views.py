"""Self-service contractual earnings. Usage credits never imply USD debt."""
import re

from importlib import import_module
from importlib.util import find_spec

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import DatabaseError, transaction
from django.db.models import Sum
from django.shortcuts import get_object_or_404
from django.utils import timezone
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework.authentication import SessionAuthentication, get_authorization_header
from rest_framework.exceptions import AuthenticationFailed, PermissionDenied
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from dj.apps.g12f.models import Creator
from dj.apps.g12f.validators import validate_zcash_address
from dj.apps.ktauth.authentication import AccountEpochTokenAuthentication
from dj.apps.ledger.models import Config
from dj.free2z.throttling import POLLING_THROTTLES
from . import contracts, serializers as wire, services
from .models import CompensationAgreement, CompensationSchedule, CreatorPayable, EconomicPolicy, FundingReservation, LegacyClaim, PayableJournal, PaymentRequest


HELD_STATES = ('requested', 'approved', 'signing', 'broadcast_unknown', 'broadcast')
IN_FLIGHT_STATES = ('signing', 'broadcast_unknown', 'broadcast')
EXPECTED_ACTOR_QUERY = OpenApiParameter('expected_actor_id', int, required=False, description='Original displayed account ID. A mismatch refuses the private read with actor_changed; successful responses identify the authenticated actor.')


def usd(amount):
    return f'{amount // 1_000_000_000}.{amount % 1_000_000_000:09d}'


def error(code, detail, status=409):
    return Response({'code': code, 'detail': detail}, status=status, headers={'Cache-Control': 'no-store'})


def database_refusal(exc):
    """Translate only identified policy refusals after savepoint rollback."""
    cause = exc.__cause__
    state = getattr(cause, 'sqlstate', None)
    if state == '23514' and 'economic_writers_fenced' in str(cause):
        return error('economic_writers_fenced', 'Financial writers are temporarily fenced; recorded obligations and original requests are preserved.')
    if state == '55P03' and 'economy_economicpolicy' in str(cause):
        return error('economic_writers_busy', 'Policy is changing; retry the original instruction after it completes.', 503)
    return None


def product_module():
    # These adapters may ship before the separately reviewed writer integration.
    # Absence means unavailable, never a fabricated balance or active policy.
    name = 'dj.apps.economy.products'
    return import_module(name) if find_spec(name) is not None else None


def capabilities():
    policy = EconomicPolicy.objects.get(pk=True)
    config = Config.objects.get(pk=True)
    name = 'dj.apps.economy.epoch'
    module = import_module(name) if find_spec(name) is not None else None
    integrated = bool(module and module.product_integration_available())
    active = bool(policy.version == 1 and not policy.fenced and config.writer_boundary and config.dual_write and not config.heal_enabled and integrated)
    return {'policy_version': policy.version, 'active': active, 'creator_compensation_available': active,
        'zec_funding_method': dict(contracts.zec_funding_method(contracts.ZEC_FUNDING_VERSION))}


def schedule_references():
    return [{'service': item['service'], 'version': item['version'], 'digest': item['digest']} for item in contracts.SERVICE_SCHEDULES.values()]


def agreement_for(account, *, current=False):
    if account.legal_payee_id is None:
        return None
    query = CompensationAgreement.objects.filter(creator_id=account.creator_id, accepted_by_id=account.creator_id,
        legal_payee_id=account.legal_payee_id, effective_at__lte=services._db_now())
    if current:
        query = query.filter(revoked_at__isnull=True)
    for agreement in query.order_by('-accepted_at', '-pk'):
        if contracts.creator_contract(agreement.contract_version, agreement.contract_digest) is not None:
            return agreement
    return None


def has_current_schedule(agreement):
    if agreement is None or (agreement.contract_version, agreement.contract_digest) != (contracts.CREATOR_CONTRACT_VERSION, contracts.CREATOR_CONTRACT_DIGEST):
        return False
    accepted = agreement.acceptance_evidence.get('schedules', [])
    now = services._db_now()
    for schedule in CompensationSchedule.objects.filter(contract_version=agreement.contract_version, effective_at__lte=now):
        published = contracts.published_schedule(schedule.service)
        if (published and (schedule.ends_at is None or schedule.ends_at > now)
                and schedule.version == published['version'] and schedule.published_digest == published['digest']
                and schedule.nusd_per_allocated_m2z == published['rate_nusd_per_allocated_m2z']
                and {'service': schedule.service, 'version': schedule.version, 'digest': schedule.published_digest} in accepted):
            return True
    return False


def legacy_pending(creator_id):
    relevant = False
    for claim in LegacyClaim.objects.filter(creator_id=creator_id).prefetch_related('decisions'):
        if not any(claim.evidence.get(key) is True for key in ('relevant_possible_compensation', 'possible_redeemability')):
            continue
        relevant = True
        final = any(decision.basis.get('final') is True and all(decision.basis.get(key) for key in
            ('legal_basis', 'source_reference', 'decision_reference')) for decision in claim.decisions.all())
        if not final:
            return True
    return False if relevant else None


def payment_payload(payment):
    settled = None
    if payment.state in IN_FLIGHT_STATES + ('confirmed',) and payment.settlement:
        source = payment.settlement
        settled = {**{key: source[key] for key in ('usd_per_zec', 'amount_zec', 'fee_zec', 'quoted_at', 'pricing_method_version')},
            'rate_source': source.get('public_rate_source'), 'usd_satisfaction': usd(int(source['usd_satisfaction_nusd'])),
            'rounding_expense': usd(int(source['rounding_nusd']))}
    return {'id': str(payment.pk), 'currency': 'USD', 'amount': usd(payment.amount_nusd), 'state': payment.state,
        'held': payment.state in HELD_STATES, 'created_at': payment.created_at, 'updated_at': payment.updated_at,
        'txid': payment.txid, 'settlement': settled}


class SelfView(APIView):
    authentication_classes = [AccountEpochTokenAuthentication, SessionAuthentication]
    permission_classes = [IsAuthenticated]

    def initial(self, request, *args, **kwargs):
        # A browser session alongside a delegated credential does not upgrade it.
        header = get_authorization_header(request).split()
        if header and header[0].lower() == b'bearer':
            raise PermissionDenied('Delegated SDK authorization does not permit financial self-service.')
        super().initial(request, *args, **kwargs)

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response['Cache-Control'] = 'no-store'
        return response

    def read_actor_refusal(self, request):
        values = request.query_params.getlist('expected_actor_id')
        if not values:
            return None
        if len(values) != 1 or not re.fullmatch(r'[1-9][0-9]{0,18}', values[0]) or int(values[0]) > 9223372036854775807:
            return error('invalid_request', 'Provide the original positive integer account ID.', 400)
        if int(values[0]) != request.user.pk:
            return error('actor_changed', 'The signed-in account changed. Keep the original account view.')
        return None

    def locked_actor(self, request):
        actor = Creator.objects.select_for_update().get(pk=request.user.pk)
        if actor.kt_account_epoch != request.user.kt_account_epoch:
            raise AuthenticationFailed('Account authorization changed; authenticate again.')
        return actor

    def authentication_evidence(self, request, actor):
        return {'actor_id': actor.pk, 'account_epoch': actor.kt_account_epoch,
            'credential_kind': 'knox' if request.auth is not None else 'session', 'authenticated_at': timezone.now().isoformat(),
            'authentication_reference': f'authenticated-self:{actor.pk}:epoch:{actor.kt_account_epoch}'}


class CapabilitiesView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    # Browser capability refreshes perform policy/config reads: the poll bucket.
    throttle_classes = POLLING_THROTTLES

    @extend_schema(responses={200: wire.CapabilitiesSerializer}, operation_id='economy_capabilities', tags=['economy'])
    def get(self, request):
        return Response(capabilities(), headers={'Cache-Control': 'no-store'})


class AgreementView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    # Fixed in-memory legal resources: no DB/provider work and no IP bucket.
    # Capability polling must not exhaust access to the actual consent text.
    throttle_classes = []

    @extend_schema(responses=wire.AgreementSerializer, operation_id='economy_agreement', tags=['economy'])
    def get(self, request):
        return Response({'version': contracts.CREATOR_CONTRACT_VERSION, 'digest': contracts.CREATOR_CONTRACT_DIGEST,
            'text': contracts.CREATOR_CONTRACT_TEXT, 'schedules': [dict({key: item[key] for key in ('service', 'version', 'digest', 'text')}, currency='USD', usd_per_allocated_m2z='0.000010000')
                for item in contracts.SERVICE_SCHEDULES.values()]}, headers={'Cache-Control': 'no-store'})


class AcceptAgreementView(SelfView):
    @extend_schema(request=wire.AcceptAgreementSerializer, responses={200: wire.AcceptedAgreementSerializer, 409: wire.EconomyErrorSerializer, 503: wire.EconomyErrorSerializer}, operation_id='economy_agreement_accept', tags=['economy'])
    def post(self, request):
        serializer = wire.AcceptAgreementSerializer(data=request.data)
        if not serializer.is_valid():
            return error('invalid_request', 'Explicit acknowledgement and displayed document references are required.', 400)
        data = serializer.validated_data
        if data['expected_actor_id'] != request.user.pk:
            return error('actor_changed', 'The signed-in account changed. Preserve the original instruction and return to its account.')
        if (data['version'] != contracts.CREATOR_CONTRACT_VERSION or data['digest'] != contracts.CREATOR_CONTRACT_DIGEST
                or sorted(data['schedules'], key=lambda item: item['service']) != sorted(schedule_references(), key=lambda item: item['service'])):
            return error('agreement_changed', 'Display the current agreement and all service schedules before accepting.')
        if services.CONTRACT_VERSION != contracts.CREATOR_CONTRACT_VERSION:
            return error('agreement_integration_unavailable', 'Acceptance of the current prospective agreement is awaiting its reviewed backend integration.', 503)
        with transaction.atomic():
            actor = self.locked_actor(request)
            if not actor.is_active:
                raise PermissionDenied('Future participation requires an active account; recorded debts remain owed.')
            account = CreatorPayable.objects.select_for_update().filter(creator=actor).first()
            if account is None or account.legal_payee_id is None:
                return error('earnings_onboarding_required', 'Complete identity intake at /kyc and contact support for verified legal-payee binding.')
            prior = agreement_for(account, current=True)
            if prior and prior.contract_version == data['version'] and prior.acceptance_evidence.get('schedules') != schedule_references():
                return error('agreement_schedule_conflict', 'Existing acceptance cannot be replaced with unseen schedules.')
            agreement = services.accept_agreement(creator_id=actor.pk, legal_payee_id=account.legal_payee_id,
                contract_version=data['version'], contract_digest=data['digest'], acceptance_evidence={
                    'document_reference': f"{data['version']}:{data['digest']}", 'actor_authentication': self.authentication_evidence(request, actor),
                    'authority_reference': f'authenticated-self:{actor.pk}:bound-payee:{account.legal_payee_id}',
                    'schedules': schedule_references(), 'activation_required': True, 'prospective_policy_version': 1, 'acknowledged': True})
        return Response({'version': agreement.contract_version, 'digest': agreement.contract_digest,
            'accepted_at': agreement.accepted_at, 'agreement_accepted': True})


class EarningsView(SelfView):
    @extend_schema(parameters=[EXPECTED_ACTOR_QUERY], responses={200: wire.EarningsSerializer, 400: wire.EconomyErrorSerializer, 409: wire.EconomyErrorSerializer}, operation_id='economy_earnings', tags=['economy'])
    def get(self, request):
        refusal = self.read_actor_refusal(request)
        if refusal is not None:
            return refusal
        with transaction.atomic():
            account = CreatorPayable.objects.select_for_update(of=('self',)).select_related('legal_payee').filter(creator=request.user).first()
            if account is None:
                return error('earnings_onboarding_required', 'No prospective earnings account is recorded. Complete identity intake at /kyc and contact support for verified payee binding.')
            agreement = agreement_for(account)
            in_flight = PaymentRequest.objects.filter(account=account, state__in=IN_FLIGHT_STATES).aggregate(amount=Sum('amount_nusd'))['amount'] or 0
            result = {'actor_id': request.user.pk, 'currency': 'USD', 'balance': usd(account.balance_nusd), 'held': usd(account.held_nusd),
                'available': usd(max(account.balance_nusd-account.held_nusd, 0)), 'payment_in_flight': usd(in_flight),
                'recovery': None, 'recovery_available': False, 'agreement_accepted': agreement is not None,
                'compensation_eligible': bool(request.user.is_active and capabilities()['active'] and has_current_schedule(agreement_for(account, current=True))),
                'legal_payee': {'display_name': account.legal_payee.legal_name, 'jurisdiction': account.legal_payee.jurisdiction} if account.legal_payee_id else None,
                'onboarding_required': account.legal_payee_id is None,
                'recent_activity': [{'id': f'payable:{row.pk}', 'service': row.admission.service, 'currency': 'USD',
                    'amount': usd(row.delta_nusd), 'created_at': row.created_at}
                    for row in PayableJournal.objects.filter(account=account, kind='service',
                        admission__service__in=tuple(contracts.SERVICE_SCHEDULES)).select_related('admission').order_by('-created_at', '-pk')[:20]]}
            pending = legacy_pending(request.user.pk)
            if pending is not None:
                result['legacy_review_pending'] = pending
        return Response(result)


class PaymentsView(SelfView):
    @extend_schema(parameters=[EXPECTED_ACTOR_QUERY], responses={200: wire.PaymentListSerializer, 400: wire.EconomyErrorSerializer, 409: wire.EconomyErrorSerializer}, operation_id='economy_payments_list', tags=['economy'])
    def get(self, request):
        refusal = self.read_actor_refusal(request)
        if refusal is not None:
            return refusal
        rows = PaymentRequest.objects.filter(account__creator=request.user).order_by('-created_at', '-pk')[:50]
        return Response({'actor_id': request.user.pk, 'results': [payment_payload(row) for row in rows]})

    @extend_schema(request=wire.PaymentCreateSerializer, responses={200: wire.PaymentSerializer, 400: wire.EconomyErrorSerializer, 409: wire.EconomyErrorSerializer}, operation_id='economy_payment_request', tags=['economy'])
    def post(self, request):
        if isinstance(request.data, dict) and type(request.data.get('expected_actor_id')) is int and request.data['expected_actor_id'] == request.user.pk:
            key = request.data.get('idempotency_key')
            if isinstance(key, str) and 0 < len(key) <= 128:
                original = PaymentRequest.objects.filter(account__creator=request.user, idempotency_key=key).first()
                if original is not None:
                    if (request.data.get('amount'), request.data.get('address')) != (usd(original.amount_nusd), original.address):
                        return error('idempotency_conflict', 'This key already identifies a recorded request. Inspect its receipt before correcting the instruction.')
                    return Response(payment_payload(original))
        serializer = wire.PaymentCreateSerializer(data=request.data)
        if not serializer.is_valid():
            return error('invalid_request', 'Provide an exact positive USD amount, address and stable idempotency key.', 400)
        data = serializer.validated_data
        amount = int(data['amount'].replace('.', ''))
        if data['expected_actor_id'] != request.user.pk:
            return error('actor_changed', 'The signed-in account changed. Preserve the original payment instruction.')
        # Validate before any financial write: correction of a refused address is safe.
        try:
            validate_zcash_address(data['address'])
        except DjangoValidationError:
            return error('invalid_payment_address', 'Provide a valid Zcash payment address.', 400)
        if not data['address'].startswith(('u1', 'zs')):
            return error('shielded_payment_address_required', 'A supported mainnet shielded Zcash address is required.', 400)
        def existing_receipt():
            row = PaymentRequest.objects.filter(account__creator=request.user, idempotency_key=data['idempotency_key']).first()
            if row is None:
                return None
            if (row.amount_nusd, row.address) != (amount, data['address']):
                return error('idempotency_conflict', 'This key already identifies a different request.')
            return Response(payment_payload(row))
        existing = existing_receipt()
        if existing is not None:
            return existing
        try:
            with transaction.atomic():
                services.pin_policy()
                actor = self.locked_actor(request)
                existing = existing_receipt()
                if existing is not None:
                    return existing
                account = CreatorPayable.objects.select_for_update().filter(creator=actor).first()
                agreement = agreement_for(account) if account else None
                if agreement is None:
                    return error('payment_method_requires_actual_accepted_agreement', 'A verified bound payee and actual accepted payment terms are required.')
                document = contracts.creator_contract(agreement.contract_version, agreement.contract_digest)
                payment = services.request_payment(creator_id=actor.pk, amount_nusd=amount, address=data['address'], idempotency_key=data['idempotency_key'],
                    address_authorization={'actor_authentication': self.authentication_evidence(request, actor),
                        'address_reference': f"self-payment-request:{actor.pk}:{data['idempotency_key']}",
                        'pricing_method_version': document['payment_method_version'], 'pricing_method_digest': document['payment_method_digest'],
                        'compensation_agreement_id': agreement.pk, 'payment_terms_reference': f'{agreement.contract_version}:surviving-payment-terms'})
        except services.EconomicRefusal as exc:
            return error(str(exc), 'The request was refused; any existing obligation remains recorded.')
        except DatabaseError as exc:
            refused = database_refusal(exc)
            if refused is None:
                raise
            return refused
        return Response(payment_payload(payment))


class PaymentDetailView(SelfView):
    @extend_schema(responses=wire.PaymentSerializer, operation_id='economy_payment_status', tags=['economy'])
    def get(self, request, payment_id):
        return Response(payment_payload(get_object_or_404(PaymentRequest, pk=payment_id, account__creator=request.user)))


class UsageQuoteView(SelfView):
    @extend_schema(parameters=[OpenApiParameter('amount', str, required=True)], responses={503: wire.EconomyErrorSerializer}, operation_id='economy_usage_purchase_quote', tags=['economy'])
    def get(self, request):
        return error('usage_purchase_unavailable', 'Earnings-funded usage purchases are not offered. Your recorded USD earnings remain owed.', 503)


class UsagePurchasesView(SelfView):
    @extend_schema(request=wire.UsagePurchaseSerializer, responses={503: wire.EconomyErrorSerializer}, operation_id='economy_usage_purchase', tags=['economy'])
    def post(self, request):
        # Owner-deferred product: never call prepared internal quote/setoff helpers.
        return error('usage_purchase_unavailable', 'Earnings-funded usage purchases are not offered. Your recorded USD earnings remain owed.', 503)


class FundingResolutionsView(SelfView):
    @extend_schema(parameters=[EXPECTED_ACTOR_QUERY], responses={200: wire.FundingResolutionListSerializer, 400: wire.EconomyErrorSerializer, 409: wire.EconomyErrorSerializer}, operation_id='economy_funding_resolutions', tags=['economy'])
    def get(self, request):
        refusal = self.read_actor_refusal(request)
        if refusal is not None:
            return refusal
        name = 'dj.apps.economy.funding'
        if find_spec(name) is not None:
            return Response({'actor_id': request.user.pk, 'results': import_module(name).funding_resolution_statuses(creator_id=request.user.pk, limit=50),
                'zec_funding_capacity': services.funding_capacity_preview(request.user.pk)})
        rows = FundingReservation.objects.filter(recipient=request.user, purchaser=request.user, state='resolution').order_by('-created_at', '-pk')[:50]
        return Response({'actor_id': request.user.pk, 'zec_funding_capacity': services.funding_capacity_preview(request.user.pk), 'results': [{'status': 'pending_resolution', 'credited': False, 'resolution_id': f'funding:{row.pk}',
            'reason': 'funding_requires_review', 'created_at': row.created_at} for row in rows]})
