from django import forms

class CombineTagsForm(forms.Form):
    preferred = forms.CharField(label='Preferred', max_length=100)
    redundant = forms.CharField(label='Redundant', max_length=100)
