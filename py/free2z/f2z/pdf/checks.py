from pdfrw import PdfReader

# Load the PDF form
# pdf_template_path = 'document.pdf'
# pdf_template_path = 'filled_fw8ben.pdf'
pdf_template_path = 'filled_fw9.pdf'
form = PdfReader(pdf_template_path)

# Inspect checkbox fields and print their current values
for page in form.pages:
    annotations = page['/Annots']
    if annotations:
        for annotation in annotations:
            if annotation['/Subtype'] == '/Widget' and annotation.get('/FT') == '/Btn':
                if annotation['/T']:
                    field_name = annotation['/T'].to_unicode()
                    current_value = annotation['/V'] if annotation.get('/V') else 'Not set'
                    print(f'{field_name}: current value is {current_value}')
                    current_as = annotation['/AS'] if annotation.get('/AS') else 'Not set'
                    print(f'{field_name}: current AS is {current_as}')
