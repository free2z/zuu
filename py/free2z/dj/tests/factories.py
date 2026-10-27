from decimal import Decimal

import factory

from dj.apps.g12f.models.creator import Creator


class CreatorFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = Creator
        skip_postgeneration_save = True

    username = factory.Sequence(lambda n: f"user{n}")
    tuzis = Decimal("1000")
    member_price = Decimal("10")

    @factory.post_generation
    def password(self, create, extracted, **kwargs):
        raw = extracted or "password"
        self.set_password(raw)
        if create:
            self.save()
