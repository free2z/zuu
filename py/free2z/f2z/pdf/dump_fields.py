from pdfrw import PdfReader

# Load the PDF file
pdf_path = 'fw9.pdf'
pdf = PdfReader(pdf_path)

# Iterate through each page and print field names
for page in pdf.pages:
    annotations = page.Annots
    if annotations:
        for annotation in annotations:
            if annotation.Subtype == '/Widget' and annotation.T:
                print(annotation.T.to_unicode())
