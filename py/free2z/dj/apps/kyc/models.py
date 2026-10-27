import os
import uuid

from django.db import models
from django.contrib.auth import get_user_model
from django.core.exceptions import ObjectDoesNotExist
from django.core.validators import FileExtensionValidator, RegexValidator
from django.utils.html import format_html, format_html_join

from django_countries.fields import CountryField

from f2z.pdf.w9 import W9Values, fill_w9
from f2z.pdf.w8ben import W8BENValues, fill_w8ben

from .validation import (
    KYC_DOCUMENT_EXTENSIONS,
    KYC_IMAGE_EXTENSIONS,
    KYC_TAX_FORM_EXTENSIONS,
    normalize_stored_name,
)

# https://free2z.com/uploadz/public/free2z/fw9.pdf
# https://free2z.com/uploadz/public/free2z/fw8ben.pdf
# https://free2z.com/uploadz/public/free2z/fw8bene.pdf


User = get_user_model()


ssn_validator = RegexValidator(regex=r'^\d{9}$', message="SSN must be 9 digits.")
ein_validator = RegexValidator(regex=r'^\d{9}$', message="EIN must be 9 digits.")


def get_upload_path(instance, filename):
    """
    `<profile uuid>/<slugified stem><allowlisted extension>` — tax forms.

    The filename used to be stored verbatim, which handed the attacker
    the stored extension and therefore the `Content-Type` these documents are
    served with. See `validation.normalize_stored_name`.
    """
    return os.path.join(str(instance.profile.id), normalize_stored_name(filename))


def get_profile_upload_path(instance, filename):
    """`<profile uuid>/<slugified stem><allowlisted extension>` — identity docs."""
    return os.path.join(str(instance.id), normalize_stored_name(filename))


# Extensions whose served Content-Type a browser will actually render in the
# `<img>` tag the admin review page uses. HEIC/AVIF are accepted uploads but
# only Safari renders them, and a PDF never will, so those get a link instead
# of a broken image.
PREVIEWABLE_EXTENSIONS = frozenset({
    '.jpg', '.jpeg', '.jpe', '.png', '.gif', '.webp',
})


class GetURLMixin:
    def get_url(self):
        if self.file:
            # "name" includes the path
            return f"/uploadz/private/{self.file.name}"
        return None


class UserProfile(models.Model):
    """
    https://www.irs.gov/pub/irs-pdf/fw8ben.pdf
    https://www.irs.gov/pub/irs-pdf/fw9.pdf

    for w8bene we are going to make the user upload it themselves.
    https://www.irs.gov/pub/irs-pdf/fw8bene.pdf

    Hold the basic info to split out the form we need.
    """
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.OneToOneField(User, on_delete=models.CASCADE)
    is_us = models.BooleanField(null=True)
    is_individual = models.BooleanField(null=True)
    # https://www.irs.gov/newsroom/details-on-using-e-signatures-for-certain-forms
    tax_form_signature = models.CharField(max_length=255, blank=True)
    created_at = models.DateField(auto_now_add=True)
    updated_at = models.DateField(auto_now=True)

    # The validators only fire on full_clean() (ModelForms, the Django admin);
    # the real gate is `validation.validate_kyc_upload()` in the views, which
    # checks the *bytes*. These are here so a staff member cannot re-introduce
    # an active-document extension by hand through the admin form. Same
    # belt-and-braces the uploads app uses.
    id_front = models.ImageField(
        upload_to=get_profile_upload_path, null=True, blank=True,
        validators=[FileExtensionValidator(
            allowed_extensions=list(KYC_IMAGE_EXTENSIONS))],
    )
    id_back = models.ImageField(
        upload_to=get_profile_upload_path, null=True, blank=True,
        validators=[FileExtensionValidator(
            allowed_extensions=list(KYC_IMAGE_EXTENSIONS))],
    )
    additional_document = models.FileField(
        upload_to=get_profile_upload_path, null=True, blank=True,
        validators=[FileExtensionValidator(
            allowed_extensions=list(KYC_DOCUMENT_EXTENSIONS))],
    )
    live_photo = models.ImageField(
        upload_to=get_profile_upload_path, null=True, blank=True,
        validators=[FileExtensionValidator(
            allowed_extensions=list(KYC_IMAGE_EXTENSIONS))],
    )

    application_status = models.CharField(
        max_length=20,
        choices=[
            ["NEW", "New"],
            ["PENDING", "Pending"],
            ["APPROVED", "Approved"],
            ["REJECTED", "Rejected"],
        ],
        default="NEW",
    )

    # Written by a human reviewer in the admin when they set the status to
    # REJECTED. Surfaced read-only to the applicant so "rejected" is actionable
    # ("your ID photo is unreadable") instead of a dead end. Blank for every
    # other status; nothing clears it automatically, so a re-application that
    # goes back to NEW still shows what went wrong last time.
    rejection_reason = models.TextField(blank=True, default='')

    def __str__(self):
        return self.user.username

    def can_edit(self):
        return self.application_status == "NEW"

    def get_tax_form(self):
        if self.is_us:
            return self.w9
        else:
            if self.is_individual:
                return self.w8ben
            return self.w8bene

    def get_tax_form_url(self):
        # `self.w9` / `self.w8ben` / `self.w8bene` raise
        # RelatedObjectDoesNotExist when the row is absent, so the old
        # `if self.get_tax_form():` made the admin change page 500 for any
        # profile without a tax form — i.e. every brand-new applicant.
        try:
            tax_form = self.get_tax_form()
        except ObjectDoesNotExist:
            tax_form = None
        if tax_form and tax_form.file:
            url = tax_form.get_url()
            # format_html, not mark_safe on an f-string: `url` is derived from
            # a stored file name and must be escaped into the attribute, not
            # trusted into it.
            return format_html("<a target='_blank' href='{}'>{}</a>", url, url)
        return "No tax form uploaded"

    def get_id_url(self, doc_type):
        if doc_type == 'id_front':
            if self.id_front:
                return f"/uploadz/private/{self.id_front.name}"
        elif doc_type == 'id_back':
            if self.id_back:
                return f"/uploadz/private/{self.id_back.name}"
        elif doc_type == 'additional_document':
            if self.additional_document:
                return f"/uploadz/private/{self.additional_document.name}"
        elif doc_type == 'live_photo':
            if self.live_photo:
                return f"/uploadz/private/{self.live_photo.name}"
        return None

    # Render the uploaded identity documents for the admin review page.
    #
    # This used to interpolate URLs into a string and `mark_safe` the result.
    # The values are internal `/uploadz/private/<uuid>/<name>` paths so it was
    # not reachable, but "trust a formatted string" is exactly the pattern that
    # produced  one file over; `format_html` escapes each value into its
    # placeholder and cannot be made to stop.
    def get_id_images(self):
        parts = []
        for field, label in (
            ('id_front', 'ID Front'),
            ('id_back', 'ID Back'),
            ('additional_document', 'Additional Document'),
            ('live_photo', 'Live Photo'),
        ):
            stored = getattr(self, field)
            if not stored:
                continue
            url = self.get_id_url(field)
            ext = os.path.splitext(stored.name or '')[1].lower()
            if ext in PREVIEWABLE_EXTENSIONS:
                parts.append(format_html(
                    "<h5>{}</h5><img src='{}' width='200px' />", label, url))
            else:
                # PDFs and HEIC/AVIF do not render in an <img>. A link keeps
                # the document reachable instead of showing a broken image.
                parts.append(format_html(
                    "<h5>{}</h5><a target='_blank' href='{}'>{}</a>",
                    label, url, stored.name))
        return format_html_join('', '{}', ((part,) for part in parts))


# class IdentityDocument(models.Model, GetURLMixin):
#     TYPE_CHOICES = [
#         ('id_front', 'ID Front'),
#         ('id_back', 'ID Back'),
#         ('additional_document', 'Additional Document'),
#         ('live_photo', 'Live Photo'),
#     ]
#     id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
#     profile = models.ForeignKey(UserProfile, on_delete=models.CASCADE)
#     doc_type = models.CharField(max_length=50, choices=TYPE_CHOICES)
#     file = models.FileField(upload_to=get_upload_path)

#     def __str__(self):
#         return f"{self.user_profile.user.username} - {self.doc_type}"


TAX_CLASSIFICATION_CHOICES = [
    ('individual', 'Individual/sole proprietor or single-member LLC'),
    ('c_corporation', 'C Corporation'),
    ('s_corporation', 'S Corporation'),
    ('partnership', 'Partnership'),
    ('trust_estate', 'Trust/estate'),
    ('limited_liability_company', 'Limited liability company. Enter the tax classification (C=C corporation, S=S corporation, P=partnership) '),
    ('other', 'Other'),
]

LLC_TAX_CLASSIFICATION_CHOICES = [
    ('c', 'C Corporation'),
    ('s', 'S Corporation'),
    ('p', 'Partnership'),
]


class W9(models.Model, GetURLMixin):
    profile = models.OneToOneField(UserProfile, on_delete=models.CASCADE)
    file = models.FileField(
        upload_to=get_upload_path, blank=True, null=True,
        validators=[FileExtensionValidator(
            allowed_extensions=list(KYC_TAX_FORM_EXTENSIONS))],
    )
    created_at = models.DateField(auto_now_add=True)
    updated_at = models.DateField(auto_now=True)

    full_name = models.CharField(max_length=255)
    business_name = models.CharField(max_length=255, blank=True)
    tax_classification = models.CharField(max_length=50, choices=TAX_CLASSIFICATION_CHOICES)
    llc_tax_classification = models.CharField(max_length=50, choices=LLC_TAX_CLASSIFICATION_CHOICES, blank=True)
    exempt_payee_code = models.CharField(max_length=50, blank=True)
    exemption_from_fatca = models.CharField(max_length=50, blank=True)
    address = models.CharField(max_length=255)
    city_state_zip = models.CharField(max_length=255)
    requester_name_address = models.TextField(blank=True)
    account_numbers = models.TextField(blank=True)
    ssn = models.CharField(max_length=9, blank=True, validators=[ssn_validator])
    ein = models.CharField(max_length=9, blank=True, validators=[ein_validator])

    def __str__(self):
        return self.user.username

    def to_pdf_dict(self) -> dict:
        # Maps user-friendly field names to PDF field names
        return W9Values(
            full_name=self.full_name or "",
            business_name=self.business_name or "",
            tax_classification=self.tax_classification,
            llc_tax_classification=self.llc_tax_classification or "",
            exempt_payee_code=self.exempt_payee_code or "",
            exemption_from_fatca=self.exemption_from_fatca or "",
            address=self.address,
            city_state_zip=self.city_state_zip,
            requester_name_address=self.requester_name_address or "",
            account_numbers=self.account_numbers or "",
            ssn=self.ssn,
            ein=self.ein,
        ).to_pdf_dict()


class W8BEN(models.Model, GetURLMixin):
    """
    Skipping the treaty stuff.
    We can give people the option to fill it out by hand and upload it.
    """
    profile = models.OneToOneField(UserProfile, on_delete=models.CASCADE)
    file = models.FileField(
        upload_to=get_upload_path, blank=True, null=True,
        validators=[FileExtensionValidator(
            allowed_extensions=list(KYC_TAX_FORM_EXTENSIONS))],
    )
    created_at = models.DateField(auto_now_add=True)
    updated_at = models.DateField(auto_now=True)

    full_name = models.CharField(max_length=255)
    citizenship_country = CountryField()
    permanent_residence_address = models.CharField(max_length=255)
    permanent_residence_city_state_zip = models.CharField(max_length=255)
    permanent_residence_country = CountryField()
    mailing_address = models.CharField(max_length=255, blank=True)
    mailing_city_state_zip = models.CharField(max_length=255, blank=True)
    mailing_country = CountryField(blank=True)
    tin = models.CharField(max_length=255, blank=True)
    foreign_tin = models.CharField(max_length=255, blank=True)
    foreign_tin_not_required = models.BooleanField(default=False)
    reference_numbers = models.CharField(max_length=255, blank=True)
    date_of_birth = models.DateField(null=True, blank=True)
    certification = models.BooleanField(default=False)
    certification_date = models.DateField(null=True, blank=True)
    print_name = models.CharField(max_length=255, blank=True)

    def __str__(self):
        return self.profile.user.username

    def to_pdf_dict(self) -> dict:
        # Maps user-friendly field names to PDF field names
        return W8BENValues(
            full_name=self.full_name or "",
            citizenship_country=self.citizenship_country.name,
            permanent_residence_address=self.permanent_residence_address ,
            permanent_residence_city_state_zip=self.permanent_residence_city_state_zip,
            permanent_residence_country=self.permanent_residence_country.name,
            mailing_address=self.mailing_address or "",
            mailing_city_state_zip=self.mailing_city_state_zip or "",
            mailing_country=self.mailing_country.name or "",
            us_tin=self.tin or "",
            foreign_tin=self.foreign_tin or "",
            foreign_tin_not_required=self.foreign_tin_not_required,
            reference_numbers=self.reference_numbers or "",
            date_of_birth=self.date_of_birth.strftime("%m-%d-%Y"),
            certification=self.certification,
            certification_date=self.certification_date.strftime("%m-%d-%Y"),
            print_name=self.print_name or "",
        ).to_pdf_dict()


class W8BENE(models.Model, GetURLMixin):
    profile = models.OneToOneField(UserProfile, on_delete=models.CASCADE)
    file = models.FileField(
        upload_to=get_upload_path,
        validators=[FileExtensionValidator(
            allowed_extensions=list(KYC_TAX_FORM_EXTENSIONS))],
    )
    created_at = models.DateField(auto_now_add=True)
    updated_at = models.DateField(auto_now=True)

    def __str__(self):
        return self.profile.user.username
