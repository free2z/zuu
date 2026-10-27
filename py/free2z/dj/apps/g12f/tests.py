# from decimal import Decimal
from datetime import datetime, timedelta

from django.utils import timezone
from django.test import TestCase

from .models import Creator, Subscription


class RenewTestCase(TestCase):

    def setUp(self) -> None:
        self.star = Creator.objects.create(
            username="star", member_price=10,
            tuzis=100,
        )
        self.fan = Creator.objects.create(
            username="fan", tuzis=1000,
        )
        return super().setUp()

    def test_happy_renew(self):
        sub = Subscription.objects.create(
            max_price=10,
            star=self.star,
            fan=self.fan,
        )
        self.assertTrue(sub.extend())

        # somehow self.fan gets the new value without requery?
        # refan = Creator.objects.get(username=self.fan.username)
        # restar = Creator.objects.get(username=self.star.username)
        self.assertEqual(self.fan.tuzis, 990)
        self.assertEqual(self.star.tuzis, 110)
        self.assertGreater(sub.expires, timezone.now() + timedelta(days=29))
        # print("HELLO", self.star, self.fan)

        first_expiry = sub.expires
        self.assertFalse(sub.extend())

        # A duplicate submit inside the debounce window is a no-charge replay,
        # not another month purchase. This assertion had retained the legacy
        # double-charge behavior after Subscription.extend() became retry-safe.
        self.assertEqual(sub.expires, first_expiry)
        self.assertEqual(self.fan.tuzis, 990)
        self.assertEqual(self.star.tuzis, 110)
