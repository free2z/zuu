from io import BytesIO

from pydantic import BaseModel
from typing import Optional

import pdfrw
from pdfrw import PdfReader, PdfWriter


# field_values = {
#     'f_1[0]': 'Jim Smith',
#     'f_2[0]': 'Venezuela',  # Country of citizenship
#     'f_3[0]': '150 Pathway St.', # Permanent residence address
#     'f_4[0]': 'San Francisco, Tularia 10123940', # City, state, and ZIP code of permanent residence
#     'f_5[0]': 'Venezuela', # Country of residence
#     # Assuming fields f_6[0] to f_8[0] are mailing address, city/state, and country if different from residence
#     'f_6[0]': '',  # Leave blank if same as permanent residence
#     'f_7[0]': '',
#     'f_8[0]': '',
#     'f_9[0]': 'U.S. TIN, if applicable',
#     'f_10[0]': 'Foreign TIN',
#     'c1_01[0]': 'Off',  # Check if FTIN not legally required - only a few countries
#     'f_11[0]': '',  # Reference number if any',
#     'f_12[0]': '12-05-1970', # Date of birth
#     # Fields f_13[0] to f_18[0] can be filled out by hand and uploaded if they want (after MVP?)
#     'c1_02[0]': '1',  # Certification checkbox
#     'f_20[0]': '',  # Mystery field, leave blank if not used
#     # 'Date[0]': 'MM-DD-YYYY',  # Current date for signing
#     'Date[0]': datetime.datetime.now().strftime("%m-%d-%Y"),
#     'f_21[0]': 'Jim Smith',
# }

class W8BENValues(BaseModel):
    full_name: str
    citizenship_country: str
    permanent_residence_address: str
    permanent_residence_city_state_zip: str
    permanent_residence_country: str
    mailing_address: Optional[str]
    mailing_city_state_zip: Optional[str]
    mailing_country: Optional[str]
    us_tin: Optional[str]
    foreign_tin: Optional[str]
    foreign_tin_not_required: bool
    reference_numbers: Optional[str]
    date_of_birth: str
    certification: bool
    certification_date: str
    print_name: str

    def to_pdf_dict(self) -> dict:
        # Maps user-friendly field names to PDF field names
        return {
            'f_1[0]': self.full_name or "",
            'f_2[0]': self.citizenship_country or "",
            'f_3[0]': self.permanent_residence_address or "",
            'f_4[0]': self.permanent_residence_city_state_zip or "",
            'f_5[0]': self.permanent_residence_country or "",
            'f_6[0]': self.mailing_address or "",
            'f_7[0]': self.mailing_city_state_zip or "",
            'f_8[0]': self.mailing_country or "",
            'f_9[0]': self.us_tin or "",
            'f_10[0]': self.foreign_tin or "",
            'c1_01[0]': '1' if self.foreign_tin_not_required else 'Off',
            'f_11[0]': self.reference_numbers or "",
            'f_12[0]': self.date_of_birth or "",
            'c1_02[0]': '1' if self.certification else 'Off',
            'Date[0]': self.certification_date or "",
            'f_21[0]': self.print_name or "",
        }


def fill_w8ben(blank_pdf_bytes: bytes, field_values: W8BENValues) -> bytes:
        # Read the PDF from bytes
    blank_pdf_stream = BytesIO(blank_pdf_bytes)
    form = PdfReader(blank_pdf_stream)

    # Process the PDF
    writer = PdfWriter()
    for page in form.pages:
        annotations = page['/Annots']
        if annotations:
            for annotation in annotations:
                if annotation['/Subtype'] == '/Widget' and annotation.get('/T'):
                    field_name = annotation['/T'].to_unicode()
                    if field_name in field_values:
                        # If it's a checkbox, the field might need to be set differently
                        if field_name.startswith('c'):
                            checkbox_value = field_values[field_name]
                            annotation.update(pdfrw.PdfDict(AS=pdfrw.PdfName(checkbox_value)))
                            annotation.update(pdfrw.PdfDict(V=pdfrw.PdfName(checkbox_value)))
                        else:
                            annotation.update(pdfrw.PdfDict(V='{}'.format(field_values[field_name])))

    writer.addpage(page)
    # Write the processed PDF to a byte stream
    output_pdf_stream = BytesIO()
    writer.write(output_pdf_stream, form)
    output_pdf_stream.seek(0)  # Reset stream position
    return output_pdf_stream.getvalue()
