"""Example using fictional identity and invalid tax identifiers."""
from f2z.pdf.w9 import W9Values, fill_w9

w9_values = W9Values(
    full_name='Example Person',
    business_name='Example Person LLC',
    tax_classification="individual",
    llc_tax_classification="",
    exempt_payee_code="",
    exemption_from_fatca="",
    address="150 Pathway St.",
    city_state_zip="San Francisco, Tularia 10123940",
    requester_name_address="",
    ssn="000000000",
    ein="000000000",
)

# Load the blank W9 PDF as bytes
with open('fw9.pdf', 'rb') as f:
    blank_pdf_bytes = f.read()

filled_pdf_bytes = fill_w9(blank_pdf_bytes, w9_values.to_pdf_dict())

with open('filled_fw9.pdf', 'wb') as f:
    f.write(filled_pdf_bytes)
