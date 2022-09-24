import json
from django.db import models

from django_extensions.db.fields import AutoSlugField


class CreatedUpdated(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class Media(CreatedUpdated):
    url = models.URLField()
    caption = models.CharField(max_length=255, blank=True)
    credit = models.CharField(max_length=255, blank=True)

    class Meta:
        pass

    def __str__(self) -> str:
        return super().__str__()

    def render(self) -> dict:
        return {
            "url": self.url,
            "caption": self.caption,
            "credit": self.credit,
        }


class Timeline(CreatedUpdated):
    """
    Holds the Title and Events
    """

    # "title": {
    #     "media": {
    #       "url": "//imgs.search.brave.com/NQjGzZHWJ76xjy1NXvtVrztv0RZonz5GWJiVT5oMtB8/rs:fit:474:225:1/g:ce/aHR0cHM6Ly90c2Uy/Lm1tLmJpbmcubmV0/L3RoP2lkPU9JUC5O/RjYtUDUxTEtva0g4/MFlHRXFRdi1BSGFI/YSZwaWQ9QXBp",
    #       "caption": "A Timeline of ALL HISTORY",
    #       "credit": "https://www.onceuponapicture.co.uk/"
    #     },
    #     "text": {
    #       "headline": "Human History",
    #       "text": "<p>Checkit</p>"
    #     }
    # },

    headline = models.CharField(max_length=255)
    slug = AutoSlugField(populate_from='headline')
    text = models.TextField()
    media = models.ForeignKey(
        'timelines.Media', blank=True, null=True, on_delete=models.SET_NULL)

    events = models.ManyToManyField('timelines.Event', blank=True)

    # timelinejs options
    scale_factor = models.PositiveSmallIntegerField(
        default=2, blank=True)

    class Meta:
        pass

    def __str__(self) -> str:
        return self.headline

    def render(self) -> dict:
        d = {}
        d["title"] = {
            "media": self.media.render() if self.media else None,
            "text": {
                "headline": self.headline,
                "text": self.text,
            }
        }
        d["events"] = [
            ev.render() for ev in self.events.all()
        ]
        return d

    def to_json(self) -> str:
        return json.dumps(self.render())


class Date(models.Model):
    """
    Datetime. This is sort of a hack because only year is required.
    Therefore, it's going to be a little bit better rendering the
    form widget as separate components. With a lot more time and
    money we would rather use a regular DateTimeField and just
    make fancy input/rendering for it to go to timelinejs.

    https://timeline.knightlab.com/docs/json-format.html#json-date
    """
    year = models.IntegerField()
    month = models.PositiveSmallIntegerField(
        blank=True, null=True, choices=[(n, n) for n in range(1,13)]
    )
    day = models.PositiveSmallIntegerField(
        blank=True, null=True, choices=[(n, n) for n in range(1,31)]
    )
    hour = models.PositiveSmallIntegerField(
        blank=True, null=True, choices=[(n, n) for n in range(24)]
    )
    minute = models.PositiveSmallIntegerField(
        blank=True, null=True, choices=[(n, n) for n in range(60)]
    )
    second = models.PositiveSmallIntegerField(
        blank=True, null=True, choices=[(n, n) for n in range(60)]
    )
    millisecond = models.PositiveIntegerField(blank=True, null=True)
    # display_date

    def __str__(self) -> str:
        return f"{self.year} {self.month} {self.day} {self.hour} {self.minute}"


class Event(CreatedUpdated):
    #      {
    #     "start_date": {
    #       "year": "-12000"
    #     },
    #     "end_date": {
    #       "year": "-8000"
    #     },
    #     "media": {
    #       "url": "//imgs.search.brave.com/NQjGzZHWJ76xjy1NXvtVrztv0RZonz5GWJiVT5oMtB8/rs:fit:474:225:1/g:ce/aHR0cHM6Ly90c2Uy/Lm1tLmJpbmcubmV0/L3RoP2lkPU9JUC5O/RjYtUDUxTEtva0g4/MFlHRXFRdi1BSGFI/YSZwaWQ9QXBp",
    #       "caption": "A Timeline of ALL HISTORY",
    #       "credit": "https://www.onceuponapicture.co.uk/"
    #     },
    #     "text": {
    #       "headline": "Paleolithic",
    #       "text": "<p>Early stone age</p>"
    #     }
    #   },
    start_date = models.OneToOneField(
        'timelines.Date', blank=False, 
        on_delete=models.PROTECT, related_name="start_events")
    end_date = models.OneToOneField(
        'timelines.Date', blank=False, 
        on_delete=models.PROTECT, related_name="end_events")
    headline = models.CharField(max_length=255, blank=False)
    text = models.TextField()
    media = models.ForeignKey('timelines.Media', null=True, blank=True, on_delete=models.SET_NULL)

    class Meta:
        pass

    def __str__(self) -> str:
        return self.headline

    def render(self) -> dict:
        d = {}
        d['text'] = {
            "headline": self.headline,
            "text": self.text,
        }
        d['media'] = self.media.render() if self.media else None
        d['start_date'] = {
            "year": self.start_date.year,
            "month": self.start_date.month,
            "day": self.start_date.day,
            "hour": self.start_date.hour,
            "minute": self.start_date.minute,
            "second": self.start_date.second,
            "millisecond": self.start_date.millisecond,
        }
        d['end_date'] = {
            "year": self.end_date.year,
            "month": self.end_date.month,
            "day": self.end_date.day,
            "hour": self.end_date.hour,
            "minute": self.end_date.minute,
            "second": self.end_date.second,
            "millisecond": self.end_date.millisecond,
        }
        return d
