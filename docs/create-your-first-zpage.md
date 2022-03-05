---
layout: page
title: Create your first zPage
nav_order: 20
permalink: create-your-first-zpage
# nav_exclude: true
---

# Create your first zPage

## Create a login

Provide a username and password.

## Get a new zPage

Create a new zPage with a `free2zaddr`.

## (optional) Fund your zPage

You can wait for the community to fund your page.
Or, you can go ahead and send 0.01 to the free2zaddr to gain
full access to the page.

## Edit you zPage content

Add content, change password, configure paid features (once funded)

<!--  -->

<!--
## Send private memo password

Using a [wallet of your choice](https://z.cash/wallets/), send
0.01 Zcash (or more) to the address with
an
[encrypted memo](https://electriccoin.co/blog/encrypted-memo-field/) with some information.
This can be done with the
[full node cli](https://zcash.readthedocs.io/en/latest/rtd_pages/memos.html)
or a mobile wallet.

The memo can be the literal plain-text value of the password you want to
use. We will store it
[salted and hashed](https://www.okta.com/blog/2019/03/what-are-salted-passwords-and-password-hashing/)

You can change the password anytime once you have control of your page.

The initial identity is the zaddress that you sent the funds to.
Using the password you sent as authorization, you can now take control
of the page content, pick a vanity url and point the donations to your own
shielded address.

[Update your Page](/docs/edit-a-page) -->

<!--

I can't tell if this idea is good. I donn't thinnk it's needed maybe.
better nnot to confuse people at first. Maybe some advanced paranoid options
for people later if they want.

In the future we may accept pre-hashed passwords, if there is demand.
This way, your private systems would be the only ones to ever touch the raw
password and it won't be on the blockchain. An option for now is just to change
the password for your page and the plaintext in the encrypted memo will have
no significance, even if Free2give is hacked catastrophically.

The password will be used to update the content on your page.
You can change it later. So, maybe don't worry about it too much. But,
don't lose it! We don't plan to support regaining access to lost pages because
that would require some other means of authenticating that the person trying
to reset the page is who they say they are and the rightful owner!
We may consider recovery protocols in the future. Until then just don't lose
your password and create a new page if you need to. -->

<!--
# FUTURE!!

> Future TODO: allow sending zaddress and salted hashed!!

There will be 4 possible formats to your message:

* {plain password}
* {hashed password}
* {zaddress}::{plain password}
* {zaddress}::{hashed password}

The zaddress is optional. If you don't send it, then the original address
owned by Free2give will be used as a placeholder. You can always change
this later. The easiest format is just to send a plain password. This would
be convenient for a mobile wallet. You can always change the password later
provided you don't lose the original.
We will store it
[salted and hashed](https://www.okta.com/blog/2019/03/what-are-salted-passwords-and-password-hashing/).

Guage interest ... donn't connfuse people at first though

If you never want us to know what your password is, you can send us a salted
and hashed version as made by Django's `make_password`. You can find
a snippet to do that [here](https://gist.github.com/skyl/0c6430499c46129398c4b8ac0e20e9ea)

### Format examples

If you just want to start with password, your encrypted memo can be

If you want to include a zaddress to get your page started with an address
that you own, you can supply that as the first part of the message. Then two
colons and the password.

For example, if you password was "my password" and your zaddress was

```
zs1skg55h0wc0552qpjlvgm40jn77tgn5vxchlm74xr6we2drntny702hzxw2pau98fxet8x6jwe2a
```

then the literal value of the memo should be
`zs1skg55h0wc0552qpjlvgm40jn77tgn5vxchlm74xr6we2drntny702hzxw2pau98fxet8x6jwe2a::my password`

If you would prefer to send your password pre-hashed, you could hash "my password"
which will be something like this:`'pbkdf2_sha256$260000$f6OF1YfzcyR4qXgj3eDPMI$HMJ/Mc7tLygsdD8kYgi4Xixi3qIia9LDlbrGs5xT0wM='`

With the same address, your literal memo would be:

```

 -->
