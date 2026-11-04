from django.contrib import admin
from .models import UserProfile, W9, W8BEN, W8BENE


@admin.register(UserProfile)
class UserProfileAdmin(admin.ModelAdmin):
    list_display = [
        'id', 'user', 'application_status', 'creator_tuzis',
        'created_at', 'updated_at',
    ]
    autocomplete_fields = ['user']
    search_fields = ['user__username', 'user__email_address__email']
    readonly_fields = [
        'get_tax_form_url', 'get_id_images'
    ]
    list_filter = ['application_status']
    list_select_related = ['user']

    # `rejection_reason` is shown to the applicant verbatim. Write it as
    # something they can act on ("the back of the ID is cut off"), and never
    # paste internal review notes here.

    @admin.display(description='2Z', ordering='user__tuzis')
    def creator_tuzis(self, obj):
        """The applicant's 2Z, so a reviewer can see it without leaving the queue.

        Eligibility to *apply* has never been enforced server-side — the old
        React stepper redirected below a threshold, which is exactly why a
        creator who switched UIs could no longer apply at all. The
        SvelteKit flow therefore lets anyone complete the form and leaves the
        decision here, with a human. That only works if the human can see the
        number, hence this column.

        2Z are platform credits. They are one input to a reviewer's judgement;
        they are not money and this column is not an amount owed.
        """
        return obj.user.tuzis


@admin.register(W9)
class W9Admin(admin.ModelAdmin):
    list_display = ['full_name', 'ssn', 'ein', 'created_at', 'updated_at']
    search_fields = ['full_name', 'ssn', 'ein']
    autocomplete_fields = ['profile']


@admin.register(W8BEN)
class W8BENAdmin(admin.ModelAdmin):
    list_display = ['full_name', 'citizenship_country', 'created_at', 'updated_at']
    search_fields = ['full_name', 'citizenship_country']
    autocomplete_fields = ['profile']


@admin.register(W8BENE)
class W8BENEAdmin(admin.ModelAdmin):
    list_display = ['profile', 'created_at', 'updated_at']
    search_fields = ['profile']
    autocomplete_fields = ['profile']
