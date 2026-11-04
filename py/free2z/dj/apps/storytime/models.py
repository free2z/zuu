from django.db import models
from django.conf import settings
from django.utils.text import slugify

from dj.apps.uploads.models import GenericFile


class Story(models.Model):
    creator = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    title = models.CharField(max_length=255)
    slug = models.SlugField(max_length=255)
    is_published = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = [["slug", "creator"]]
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.creator}:: {self.title}"

    def save(self, *args, **kwargs):
        if not self.slug:
            self.slug = f'{slugify(self.title)}'
        super().save(*args, **kwargs)


class Page(models.Model):
    """
    Can be an image or text, I think
    """
    story = models.ForeignKey(
        Story, on_delete=models.CASCADE, related_name='pages')
    prompt = models.CharField(max_length=512)
    image = models.ForeignKey(
        GenericFile, on_delete=models.CASCADE, related_name="story_pages",
        blank=True, null=True,
    )
    # 512 + 3072 == 3584 leaving 512 left if the prompt and content are max
    content = models.TextField(blank=True, max_length=3072)
    order = models.PositiveIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['order']

    def __str__(self):
        return self.prompt[:100]
