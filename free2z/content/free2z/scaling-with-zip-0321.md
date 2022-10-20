# Humble beginnings

The idea for Free2z hit me like a lightning bolt on February 23rd, 2022.
I decided to spin it up as fast as possible and learn
by experiencing.
Everything I did to make the proof-of-concept work was the easiest
way I could think of going forward.
One of those snap early decisions that was probably not tenable,
or at least was not ideal: 
give each new zPage it's own zaddress in the F2Z wallet - 
the "Free2z Address" of the page.

## Scaling Worries

Just in the first 2 weeks of early alpha testing,
we created over 200 addresses with over 100 transactions.
I began to think what this might do to the single full node
behind free2z over time as more addresses and transactions
accumulated.

![node](https://pbs.twimg.com/media/FMUxmctXsAIkH1_?format=jpg&name=medium)

### Rescan with many addresses

I don't know the deep details of zcashd devops. 
But, from discussions with
various people familiar with running a Zcashd fullnode,
and some helpful responses to 
[my post on the forum](https://forum.zcashcommunity.com/t/scaling-zcashd/41192)
I now have an intuitive understanding of why many zaddresses might not
scale too well. To get the balance of a particular zaddress,
the node essentially needs to "test decrypt" every transaction ever
to see if the transaction belongs to the particular zaddress
([correct me](https://twitter.com/free2zcash) if I'm wrong here).

I was going to spin up some test nodes and push them over
with excess addresses and transactions and collect some data
around how nodes fall over and why and find out 
what is the effect of giving
more memory and CPU to the node.

What is the impact of more addresses and transactions on backup,
restore, rescan, reindex, etc?

### zip-0321 to the rescue

I was about to go down a long path of trying to figure out
how I could scale full nodes to millions of zaddresses.
I still think it would be super interesting to see some
of these data, if anyone has them. It would be a good use
of Zcash grant money to get these numbers published IMHO.

But, instead of forcing a round peg into a square hole,
I refactored Free2z so that I only need 1 zaddress
at a time which can create and credit 100s or 1000s of pages.

All donations to free2z can come to the same address
whether this is upvoting a page, downvoting a page or
posting a threaded comment. Any action you can think
of can be done using a single address, thanks the magic of 
[zip-0321](https://zips.z.cash/zip-0321)
and [private memos](https://zcash.readthedocs.io/en/latest/rtd_pages/memos.html).


## Major Changes


> - zPages no longer have a dedicated zaddress in the F2Z wallet
> - `zPage.free2zaddr` is now a regular UUID v4
> - Payments and donations to F2Z now go to a single address
> - A simple JSON payload defines the behavior of the payment

### The `free2zaddr` is now a UUID instead of a zaddress!

In the initial design, I had a "free2zaddr" and a `p2paddr`
for each page. I tried to document and explain this -
the "f2z" address belonged to free2z and was for 
donations, payments and promotions -> 
***payments to free2z on behalf of the page***.
The creator of a zPage could send 0.001 to their special
address to publish the page. Then, the creator
could add their own `p2paddr` to receive messages
and funds from supporters.

This was too confusing for most people!
"Why are there two addresses and how does it work again?"

Even very smart people who are very invested 
and interested in free2z had a hard time keeping
all the details in their brain cache.
***This confusion was probably caused 
by the flawed initial design*** 😂!

Now there is only one address for the page -
the peer-to-peer address owned by the creator of the zPage!
This can be a simple zaddress, any other type of
cryptocurrency address, any arbitrary text.

Or creators can choose to include a special
zip-0321 URI of their own!


### Details

Basically a zip-0321 URI address allows the creator to
"prefill" the amount and the memo on the donor's
wallet. Effectively "requesting payment".
So, the QR Code at the top of the edit page on free2z
for this page now has the content:

```txt
zcash:zs16d60pj9ws682ewchraejujscf4crsuatyc83gzwnlgzzyphc3ydhynqv9p40gygnts83cfy5q23?amount=0.001&memo=eyJhY3QiOiJwYWdlX2Z1bmQiLCJpZCI6ImU5Nzk1NWMxLWYxODUtNDQ2Ni1iNmU2LTk4OTQyNjIxNzEzOSJ9
```

Notice how it starts with `zcash:` and has a querystring
starting with `?amount=0.001&memo=`.

If you scan this QRCode in zecwallet-lite,
instead of just filling the zaddress, you get
the amount and the memo prefilled. You can also 
copy/paste the full URI into zecwallet-lite address field
and the wallet will parse it with the same result.

One thing that zecwallet-lite currently can not do is understand
the intent of the link. NightHawk and YWallet understand the "zcash:"
protocol in a link and can automatically open in Android and prefill
the amount and the memo:

::embed[https://www.flickr.com/photos/42883531@N02/51965322569/in/dateposted-public/]

Nighthawk opens up an attractive interface ready to confirm the send:

::embed[https://www.flickr.com/photos/42883531@N02/51965042661/in/dateposted-public/]

### Code Snippets

On the client-side of free2z, I need to understand how to construct the URI,
including base64 encoding the memo in a special way. I made a couple of helper
functions for this purpose:

```ts
import { Buffer } from 'buffer';

export function getURI(
    address: string,
    amount: string,
    memo: string,
) {
    const memo64 = Buffer.from(memo).toString('base64').replace('=', '');
    return `zcash:${address}?amount=${amount}&memo=${memo64}`
}
```

I can then call this function with something like:

```ts
<QRAddress
  addr={getURI(
    current_f2z_address,
    "0.001",
    JSON.stringify({
      act: "page_fund",
      id: page.free2zaddr,  // Now just a UUID
    })
  )}
/>
```

#### Python backend

On the Python side, the code is not as pretty because there are a
few error cases to attend to - there is no memo, the memo is not
proper JSON. There's not much we can do about that other
than try to decode/deserialize the best we can.
If the sender did not mess up their prefilled payload,
then it should work.


```py
        for tx in z.recieved_by(addr):
            try:
                memo = tx['memo']
            except KeyError:
                continue

            try:
                ascii_memo = codecs.decode(
                    memo, 'hex'
                ).decode().replace("\x00", "")
            except:
                continue

            try:
                json_memo = json.loads(ascii_memo)
            except Exception as e:
                continue

            amount = tx['amount']
            action = json_memo.get('act')
            pid = json_memo.get('id')

            # Do what the payment says to do
            # based on the action, the pid,
            # and the amount
            # ...

```

---

## Conclusion

If you need to list 1,000,000 items for sale
by one seller, I think a good idea might be
to use private memos, zip-0321 and a small number
of zaddresses (maybe only 1).
Each payment can have up to 512 ascii characters
in the private memo. This payload can determine
the nature of the payment and trigger downstream
automation.

When free2z starts to compete with the likes of Amazon,
we may eventually have to think about really
scaling a large set of zaddresses. For
today we can go to millions of zPages with millions
of onchain upvotes, downvotes and comments without
having to tackle the problem of scaling the number
of zaddresses, thanks to the vast possibilities
opened by zip-0321 and private memos.

---