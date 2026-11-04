from django.db import models


class Address(models.Model):
    """
    Cache of addresses to use
    """

    address = models.CharField(max_length=128, primary_key=True)
    created_at = models.DateTimeField(auto_now_add=True)
    is_current = models.BooleanField(default=False)

    class Meta:
        ordering = ['-created_at']

    def __str__(self) -> str:
        return self.address

    @classmethod
    def get_current(cls):
        cls.objects.filter(is_current=True)[0]
