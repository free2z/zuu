"""PostgreSQL-backed classification binding for uploaded tax forms."""
import pytest
from django.core.files.uploadedfile import SimpleUploadedFile

from dj.apps.kyc.models import UserProfile, W9, W8BEN, W8BENE

pytestmark = pytest.mark.django_db


PDF = b'%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'
PROFILE_URL = '/api/kyc/user-profile'
UPLOAD_URL = '/api/kyc/upload-tax-form'
SIGN_URL = '/api/kyc/tax-form-signature'
SUBMIT_URL = '/api/kyc/change-status'
FORM_MODELS = {'W-9': W9, 'W-8BEN': W8BEN, 'W-8BEN-E': W8BENE}


@pytest.fixture(autouse=True)
def local_media(settings, tmp_path):
    settings.STORAGES = {**settings.STORAGES, 'default': {'BACKEND': 'django.core.files.storage.FileSystemStorage'}}
    settings.MEDIA_ROOT = str(tmp_path)


@pytest.fixture
def applicant(creator_factory, api_client):
    user = creator_factory()
    profile = UserProfile.objects.create(user=user, is_us=True, is_individual=True)
    api_client.force_authenticate(user=user)
    return profile, api_client


def current(profile):
    profile.refresh_from_db()
    return {'tax_form_version': profile.tax_form_version, 'tax_form_classification': required_form(profile)}


def upload(client, profile, precondition=None):
    return client.post(UPLOAD_URL, {**(precondition or current(profile)), 'file': SimpleUploadedFile('tax.pdf', PDF, content_type='application/pdf')}, format='multipart')


def sign(client, profile, name='Ada Lovelace', precondition=None):
    return client.post(SIGN_URL, {**(precondition or current(profile)), 'tax_form_signature': name}, format='json')


def submit(client, profile, precondition=None):
    return client.post(SUBMIT_URL, precondition or current(profile), format='json')


def required_form(profile):
    return 'W-9' if profile.is_us else ('W-8BEN' if profile.is_individual else 'W-8BEN-E')


def test_w9_to_w8ben_invalidates_file_and_signature_and_blocks_submit(applicant):
    profile, client = applicant
    assert upload(client, profile).status_code == 201
    assert sign(client, profile).status_code == 200
    assert client.post(PROFILE_URL, {'is_us': False}, format='json').status_code == 200
    profile.refresh_from_db()
    assert profile.tax_form_signature == ''
    assert profile.tax_form_classification == ''
    assert not W9.objects.get(profile=profile).file
    assert client.get('/api/kyc/get-tax-form-file').data['file'] is None
    assert submit(client, profile).status_code == 400


def test_w8ben_to_w8bene_requires_replacement_and_resign(applicant):
    profile, client = applicant
    client.post(PROFILE_URL, {'is_us': False, 'is_individual': True}, format='json')
    assert upload(client, profile).status_code == 201
    assert sign(client, profile).status_code == 200
    assert client.post(PROFILE_URL, {'is_individual': False}, format='json').status_code == 200
    profile.refresh_from_db()
    assert profile.tax_form_signature == ''
    assert not W8BEN.objects.get(profile=profile).file
    assert client.get('/api/kyc/get-tax-form-file').data['file'] is None
    assert submit(client, profile).status_code == 400


@pytest.mark.parametrize('is_us,is_individual,kind', [
    (True, False, 'W-9'), (False, True, 'W-8BEN'), (False, False, 'W-8BEN-E'),
])
def test_upload_replacement_resign_and_reload_allow_submit(applicant, is_us, is_individual, kind):
    profile, client = applicant
    client.post(PROFILE_URL, {'is_us': is_us, 'is_individual': is_individual}, format='json')
    assert upload(client, profile).status_code == 201
    assert sign(client, profile).status_code == 200
    profile.refresh_from_db()
    assert profile.tax_form_classification == kind
    assert FORM_MODELS[kind].objects.get(profile=profile).file
    assert client.get('/api/kyc/get-tax-form-file').data['file']
    assert submit(client, profile).status_code == 200


def test_unchanged_required_form_preserves_artifacts(applicant):
    profile, client = applicant
    upload(client, profile)
    sign(client, profile)
    # Entity/individual does not affect the required US form kind.
    assert client.post(PROFILE_URL, {'is_individual': False}, format='json').status_code == 200
    profile.refresh_from_db()
    assert profile.tax_form_classification == 'W-9'
    assert profile.tax_form_signature == 'Ada Lovelace'
    assert W9.objects.get(profile=profile).file
    assert submit(client, profile).status_code == 200


def test_legacy_unstamped_file_and_signature_fail_closed_without_deleting(applicant):
    profile, client = applicant
    response = upload(client, profile)
    assert response.status_code == 201
    legacy_file = W9.objects.get(profile=profile).file.name
    profile.tax_form_classification = ''
    profile.tax_form_signature = 'Legacy Signer'
    profile.save(update_fields=['tax_form_classification', 'tax_form_signature'])
    assert client.get('/api/kyc/get-tax-form-file').data['file'] is None
    assert sign(client, profile, 'New Signer').status_code == 400
    rejected = submit(client, profile)
    assert rejected.status_code == 400
    assert 'complete and sign' in rejected.data['error'].lower()
    profile.refresh_from_db()
    assert profile.application_status == 'NEW'
    assert profile.tax_form_signature == 'Legacy Signer'
    assert W9.objects.get(profile=profile).file.name == legacy_file


def test_stale_upload_signature_submit_and_missing_precondition_do_not_mutate(applicant):
    profile, client = applicant
    old = current(profile)
    assert upload(client, profile, old).status_code == 201
    profile.refresh_from_db()
    after_upload = current(profile)
    assert sign(client, profile, precondition=after_upload).status_code == 200
    old = after_upload
    replacement = upload(client, profile, after_upload)
    assert replacement.status_code == 201
    profile.refresh_from_db()
    assert profile.tax_form_signature == ''
    assert sign(client, profile, precondition=old).status_code == 409
    assert submit(client, profile, old).status_code == 409
    assert upload(client, profile, {'tax_form_version': profile.tax_form_version - 1, 'tax_form_classification': 'W-9'}).status_code == 409
    assert sign(client, profile).status_code == 200
    assert submit(client, profile).status_code == 200
