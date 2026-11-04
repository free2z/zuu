import pandas as pd

# Replace 'your_file.xlsx' with the path to your Excel file
excel_file = 'gemini.xlsx'
# Replace 'your_output.csv' with the desired output CSV file name
csv_file = 'gemini.csv'

# Load the Excel file
df = pd.read_excel(excel_file)

# Save to CSV, without the index
df.to_csv(csv_file, index=False)

print(f"Converted '{excel_file}' to '{csv_file}' successfully!")
