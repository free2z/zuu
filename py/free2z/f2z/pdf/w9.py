from io import BytesIO

import pdfrw
from pdfrw import PdfReader, PdfWriter
from pydantic import BaseModel, Field

from typing import Optional

# This dictionary is used to map the human-readable tax classifications to their corresponding PDF field aliases.
classifications = {
    'individual': ('c1_1[0]', '1'),
    'c_corporation': ('c1_1[1]', '2'),
    's_corporation': ('c1_1[2]', '3'),
    'partnership': ('c1_1[3]', '4'),
    'trust_estate': ('c1_1[4]', '5'),
    'limited_liability_company': ('c1_1[5]', '6'),
    'other': ('c1_1[6]', '7'),
}



class W9Values(BaseModel):
    full_name: str = Field(description="Full name as shown on your income tax return")
    business_name: Optional[str] = Field(default=None, description="Business name/disregarded entity name")
    tax_classification: str = Field(default="individual", description="Federal tax classification")
    llc_tax_classification: Optional[str] = Field(default=None, description="LLC tax classification if applicable")
    exempt_payee_code: Optional[str] = Field(default=None, description="Exempt payee code")
    exemption_from_fatca: Optional[str] = Field(default=None, description="Exemption from FATCA reporting code")
    address: str = Field(default="", description="Street address (line 1)")
    city_state_zip: str = Field(default="", description="City, state, and ZIP code (line 2)")
    account_numbers: Optional[str] = Field(default=None, description="List account number(s) here (optional)")
    requester_name_address: Optional[str] = Field(default=None, description="Requester’s name and address (optional)")

    # SSN
    ssn: Optional[str] = Field(default=None, description="Social security number")
    # EIN
    ein: Optional[str] = Field(default=None, description="Employer identification number")

    def to_pdf_dict(self) -> dict:
        # Maps user-friendly field names to PDF field names
        pdf_dict = {
            'f1_1[0]': self.full_name or "",
            'f1_2[0]': self.business_name or "",
            # classifications.get(self.tax_classification, 'Off'): '1',
            # # 'c1_1[0]': '1',
            # # 'c1_1[1]': '2',
            # # 'c1_1[2]': '3',
            # # 'c1_1[3]': '4',
            # # 'c1_1[4]': '5',
            # # 'c1_1[5]': '6',
            # # 'c1_1[6]': '7',
            'f1_3[0]': self.llc_tax_classification or "",
            'f1_5[0]': self.exempt_payee_code or "",
            'f1_6[0]': self.exemption_from_fatca or "",
            'f1_7[0]': self.address,
            'f1_8[0]': self.city_state_zip,
            'f1_9[0]': self.requester_name_address or "",
            'f1_10[0]': self.account_numbers or "",
            # # 'f1_11[0]': self.date,
            # # SSN
            # 'f1_11[0]': '123',  # 3 digits
            # 'f1_12[0]': 'ab',  # 2 digits
            # 'f1_13[0]': 'cdef',  # 4 digits
            # # EIN
            # 'f1_14[0]': 'xy',  # 2 digits
            # 'f1_15[0]': '9876543',  # 7 digits
        }

        if self.tax_classification in classifications:
            pdf_field, pdf_value = classifications[self.tax_classification]
            pdf_dict[pdf_field] = pdf_value

        if self.ssn:
            pdf_dict.update({
                'f1_11[0]': self.ssn[:3],   # First 3 digits of SSN
                'f1_12[0]': self.ssn[3:5],  # Next 2 digits of SSN
                'f1_13[0]': self.ssn[5:],   # Last 4 digits of SSN
            })

        if self.ein:
            pdf_dict.update({
                'f1_14[0]': self.ein[:2],   # First 2 digits of EIN
                'f1_15[0]': self.ein[2:],   # Last 7 digits of EIN
            })

        return pdf_dict


def fill_w9(blank_pdf_bytes: bytes, field_values: W9Values) -> bytes:
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
