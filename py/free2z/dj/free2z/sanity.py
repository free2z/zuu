"""
./manage.py output_taxevent_csv output_2022.csv --start-date 2022-01-01 --end-date 2023-01-01
./manage.py output_taxevent_csv output_2023.csv --start-date 2023-01-01 --end-date 2024-01-01
./manage.py output_taxevent_csv output_2024.csv --start-date 2024-01-01 --end-date 2025-01-01
./manage.py output_taxevent_csv output.csv
"""

import pandas as pd

chase = pd.read_csv('chase.csv', index_col=False)
gem = pd.read_csv('gemini.csv')
output = pd.read_csv('output.csv')
output_2022 = pd.read_csv('output_2022.csv')
output_2023 = pd.read_csv('output_2023.csv')
output_2024 = pd.read_csv('output_2024.csv')

chase_in = chase[(chase['Details'] == 'DSLIP') | (chase['Details'] == 'CREDIT')]
total_in = chase_in['Amount'].sum()
chase_out = chase[chase['Details'] == 'DEBIT']
total_out = chase_out['Amount'].sum()

# print(total_in + total_out)
# gem['Fee (USD) USD'].sum()

gemini_credits = gem[gem['Type'] == 'Credit']
# for i, row in gemini_credits.iterrows():
#     print(i, row)
#
# gemini_credits['ZEC Amount ZEC']
# gemini_credits['ZEC Amount ZEC'].sum()

# output_2022[output_2022['type'] == "Expense"]['usd_value'].sum()
# output_2022[output_2022['type'] == "Income"]['usd_value'].sum()

# 2022 Summary
print()
print("2022 Summary")
print("Income", output_2022[output_2022['type'] == "Income"]['usd_value'].sum())
print("Expense", output_2022[output_2022['type'] == "Expense"]['usd_value'].sum())
print("Gain/Loss", output_2022['gain_loss'].sum())

# 2023 Summary
print()
print("2023 Summary")
print("Income", output_2023[output_2023['type'] == "Income"]['usd_value'].sum())
print("Expense", output_2023[output_2023['type'] == "Expense"]['usd_value'].sum())
print("Gain/Loss", output_2023['gain_loss'].sum())

# 2024 Summary
print()
print("2024 Summary")
print("Income", output_2024[output_2024['type'] == "Income"]['usd_value'].sum())
print("Expense", output_2024[output_2024['type'] == "Expense"]['usd_value'].sum())
print("Gain/Loss", output_2024['gain_loss'].sum())

# Sanity check against full output
print()
print("Full Summary")
print("Income", output[output['type'] == "Income"]['usd_value'].sum())
print("Expense", output[output['type'] == "Expense"]['usd_value'].sum())
print("Gain/Loss", output['gain_loss'].sum())

# import IPython; IPython.embed()
