---
layout: page
title: What are zPages
nav_order: 2
permalink: what-are-zpages
---

# What are zPages?

A zPage is essentially a webpage that is associated to
private addresses on the Zcash blockchain.
zPages can be used for many purposes.
One primary use case would be to make a
[fundraising page](https://free2z.com/ui-dev).
You can also create
[arbitrary content](https://free2z.cash/python-zcash-rpc)
which can be
[public and promoted](https://free2z.cash/ariel-gabacho),
or private to anyone who has a
[cryptic url](https://free2z.com/zs1uszfq0jn42t559qupp327n52qen7ajxfdhuydc8wlhn5cvky6u72x2qeh9y3wup2tfe2za3j8zv).

## Creators

A Creator is someone who has created an account with Free2z
with a username and password. This is free and easy and requires
no third parties or personal information.
Each Creator will start with 1 new zPage.
If you don't want to participate in content creation, voting, comments, etc,
there is no reason to create an account and become a Creator.
Without an account, you are free to browse other people's zPages and
can still donate and participate in the community without ever having
created a record in the database.
[Learn more about membership](membership).

Each Creator can have 1 or more zPages.
Creating a zPage creates a unique Free2z address, `free2zaddr` for short.
This is a [Zcash shielded address](https://z.cash/technology/).
This address is owned by free2z and can be used to increase the zPage's
clout on free2z and other in-house funny money purposes.
Perhaps as-yet-unthought-of paid features in the future.

## Minimum zPage

To start a zPage, all you need is a `title` and some `content`.

The `content` is in markdown with html and css enabled.
You can do video and image embeds in your page. But,
free2z does not currently offer media hosting so you'll have to upload
your videos and images to another service.


## `free2zaddr` and `p2paddr`

Once a zPage has been funded, either by the Creator or by the community,
the Creator will be able to add their own Peer-to-Peer (p2p)
address to the zPage. This is called the `p2paddr` for short.

* `free2zaddr` - funds in the `free2zaddr` are always owned by Free2z.
  These funds can be applied to new zPages and other features and promotions.
* `p2paddr` - The peer-to-peer address, owned by the creator,
  which donors can send funds directly to. Enabled once the zPage
  has been funded with 0.01 Zcash to the `free2zaddr`.

> Note: The `p2paddr` could actually be a
  Zcash t-address or any other type of cryptocurrency address.
  Just be clear in your content what kind of address you are using.

## Vanity URL (Slug)

Funded pages can have a name in the top-level namespaces of
free2z.com, free2z.cash and free2give.xyz.
If you input the vanity slug, `new-flute`, when you are funded and published,
your page will be available at:

- https://free2z.com/new-flute
- https://free2z.cash/new-flute
- https://free2give.xyz/new-flute

If you want your page to be private to only people with a cryptic URL,
leave the vanity field blank.

### `Public`

If you want people other than you to see your post, you have to mark it
public

## Unfunded zPage

You can continue editing your unfunded page and wait
for the community to send Zcash to the `free2zaddr`.
But, the page will be limited:

* Only members can see
* Can not be promoted or searched for
* No vanity URL
* No `p2paddr`
* No comments, tagging, voting and other features

## Funded zPage

Once your zPage is funded, you gain full control and can choose
to make the page public with a vanity url, add your own `p2paddress`
and customize features for the page.

[Learn more about membership](membership).

<!--
## The full Page model


```python
from django.db import models
from django.contrib.auth.hashers import make_password, check_password


class Page(models.Model):
    """
    A page is what a user gains access to and controls the content
    """
    vanity = models.SlugField(
        blank=True, null=True, unique=True,
        help_text="Optional vanity URL field")
    title = models.CharField(max_length=128)
    content = models.TextField(max_length=10000)

    ### Authentication -
    # little extra room to grow?
    # https://github.com/unstoppabledomains/resolution/issues/202
    zaddr = models.CharField(
        blank=False, null=False,
        max_length=128, unique=True,
        help_text="Zaddress, initialized as value from g12f node, mutable",
    )
    password = models.CharField(
        max_length=256, null=False, blank=False,
        help_text="Hashed and salted password to edit page"
    )
    ############################################################
    optional_private_free_contact = models.TextField(
        default="", blank=True, max_length=5000,
        help_text="If you want to explain how we can get in touch with you.")

    # class Meta:

    def __str__(self) -> str:
        return f"{self.zaddr[:10]}-{self.title}"

    def save(self) -> None:
        # hacky, easy way to enforce salt/hash
        if not self.password.startswith("pbkdf2_sha256"):
            self.password = make_password(self.password)
        return super().save()

    def set_password(self, raw) -> None:
        self.password = make_password(raw)
        self.save()

    def check_password(self, raw) -> bool:
        return check_password(raw, self.password)
``` -->
