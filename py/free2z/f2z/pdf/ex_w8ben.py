"""Example using fictional identity and invalid tax identifiers."""
import datetime

from f2z.pdf.w8ben import W8BENValues, fill_w8ben


field_values = W8BENValues(
    full_name='Example Person',
    citizenship_country='Venezuela',
    permanent_residence_address='150 Pathway St.',
    permanent_residence_city_state_zip='San Francisco, Tularia 10123940',
    permanent_residence_country='Venezuela',
    mailing_address='',
    mailing_city_state_zip='',
    mailing_country='',
    us_tin='U.S. TIN, if applicable',
    foreign_tin='000-00-0000',
    foreign_tin_not_required=False,
    reference_numbers='',
    date_of_birth='12-05-1970',
    certification=True,
    certification_date=datetime.datetime.now().strftime("%m-%d-%Y"),
    print_name='Example Person',
).to_pdf_dict()

with open('fw8ben.pdf', 'rb') as f:
    blank_pdf_bytes = f.read()

filled_pdf_bytes = fill_w8ben(blank_pdf_bytes, field_values)

with open('filled_fw8ben.pdf', 'wb') as f:
    f.write(filled_pdf_bytes)
