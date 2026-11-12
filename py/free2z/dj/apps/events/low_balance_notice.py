"""Best-effort dispatch of the private connected-app notice.

Claiming starts the 24-hour cooldown. A claim is never retried: a worker may
die after a provider accepted mail, and retrying would duplicate it. A second
creator lock fences consent and serializes the actual send with opt-out. A
crash between claim and delivery can therefore lose a notice. This is an
informational attempt, not a guaranteed delivery.
"""
import logging
from time import monotonic
from urllib.parse import quote

from django.core.mail import EmailMultiAlternatives
from django.db import connection, transaction
from django.db.models.functions import Now

from dj.apps.emails.link_origin import get_email_link_origin
from dj.apps.emails.sender import get_email_sender
from dj.apps.emails.models import Email, OptOutEmail
from dj.apps.emails.views import build_opt_out_url, unsubscribe_headers
from dj.apps.events.models import Event
from dj.apps.g12f.models import Creator
from dj.apps.ledger.rollup import set_worker_timeouts
from dj.apps.e2ee.tasks import bounded_mail_connection

logger = logging.getLogger(__name__)

# The language is captured when the user opts in. No address or profile
# language is inferred, and old accounts use English until they opt in.
MAIL_COPY = {
    'en': ('Free2Z balance notice', 'A connected app could not use 2Z because your available balance was insufficient.', 'Turn off this notice in your account settings:', 'Unsubscribe from emails:'),
    'es': ('Aviso de saldo de Free2Z', 'Una aplicación conectada no pudo usar 2Z porque el saldo disponible era insuficiente.', 'Desactiva este aviso en la configuración de tu cuenta:', 'Cancelar la suscripción a correos:'),
    'fr': ('Avis de solde Free2Z', 'Une application connectée n’a pas pu utiliser de 2Z car le solde disponible était insuffisant.', 'Désactivez cet avis dans les paramètres de votre compte :', 'Se désabonner des e-mails :'),
    'pt-BR': ('Aviso de saldo Free2Z', 'Um aplicativo conectado não pôde usar 2Z porque o saldo disponível era insuficiente.', 'Desative este aviso nas configurações da conta:', 'Cancelar a inscrição em e-mails:'),
}


def dispatch_one(creator_id):
    # Commit the attempt before external I/O, so an ambiguous send is never
    # repeated by a worker restarted after provider acceptance.
    if connection.in_atomic_block:
        raise RuntimeError('notice dispatch requires autocommit')
    with transaction.atomic():
        with connection.cursor() as cursor:
            set_worker_timeouts(cursor)
        creator = Creator.objects.select_for_update().get(pk=creator_id)
        if not creator.is_active or not creator.low_balance_notice_enabled or not creator.low_balance_notice_pending:
            return False
        if creator.low_balance_notice_pending_epoch != creator.kt_account_epoch:
            creator.low_balance_notice_pending = False
            creator.low_balance_notice_pending_epoch = None
            creator.save(update_fields=['low_balance_notice_pending', 'low_balance_notice_pending_epoch'])
            return False
        generation = creator.low_balance_notice_generation
        account_epoch = creator.kt_account_epoch
        creator.low_balance_notice_pending = False
        creator.low_balance_notice_pending_epoch = None
        # Admission and dispatch compare against the same database clock.
        creator.low_balance_notice_attempted_at = Now()
        creator.save(update_fields=['low_balance_notice_pending', 'low_balance_notice_pending_epoch', 'low_balance_notice_attempted_at'])
    return deliver_claim(creator_id, generation, account_epoch)


def deliver_claim(creator_id, generation, account_epoch):
    with transaction.atomic():
        with connection.cursor() as cursor:
            set_worker_timeouts(cursor)
        creator = Creator.objects.select_for_update().get(pk=creator_id)
        if (not creator.is_active or not creator.low_balance_notice_enabled
                or creator.low_balance_notice_generation != generation or creator.kt_account_epoch != account_epoch):
            return False
        address = Email.objects.filter(user_id=creator_id, confirmed_at__isnull=False, get_notifications=True).first()
        if address and OptOutEmail.objects.filter(email__iexact=address.email).exists():
            address = None
        if address is None:
            Event.objects.create(receiving_user=creator, type='LOW_BALANCE_NOTICE')
        else:
            url = f"{get_email_link_origin()}/{quote(creator.username, safe='')}/dashboard/settings"
            unsubscribe = build_opt_out_url(address)
            subject, detail, settings_label, unsubscribe_label = MAIL_COPY.get(creator.low_balance_notice_locale, MAIL_COPY['en'])
            message = EmailMultiAlternatives(
                subject=subject,
                body=f'{detail}\n\n{settings_label} {url}\n\n{unsubscribe_label} {unsubscribe}',
                from_email=get_email_sender(), connection=bounded_mail_connection(),
                to=[address.email], headers=unsubscribe_headers(unsubscribe),
            )
            message.send(fail_silently=False)
    return True


def drain(limit=100, budget_seconds=5):
    # New workers may start before the migration; old workers simply ignore it.
    with connection.cursor() as cursor:
        cursor.execute("SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' "
                       "AND table_name='g12f_creator' AND column_name='low_balance_notice_pending')")
        if not cursor.fetchone()[0]:
            return 0
    ids = list(Creator.objects.filter(low_balance_notice_pending=True).order_by('pk').values_list('pk', flat=True)[:limit])
    delivered = 0
    deadline = monotonic() + budget_seconds
    for creator_id in ids:
        if monotonic() >= deadline:
            break
        try:
            delivered += int(dispatch_one(creator_id))
        except Exception as exc:
            # The committed attempt is deliberately not retried, even if the
            # provider's outcome is unknown. Never log address or mail body.
            logger.warning('low balance notice attempt failed for creator %s: %s', creator_id, type(exc).__name__)
    return delivered
