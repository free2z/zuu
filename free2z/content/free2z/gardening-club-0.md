## My Zcash Story

By 2009 I was programming professionally with Django and finishing a bachelor's in Math; but, I was a bit of a newb still.
I started going to PyCons and went from 2009-2013. I ran across Zooko a few times and even got to hang out for a few hours once or twice.
He was working on Tahoe-LAFS and a grant from DARPA for a hashing algorithm (if I remember correctly - I haven't double-checked the accuracy of my memories with others). We talked about cryptocurrency, privacy and cypherpunk stuff while I was unironically focused on full-stack GIS stuff for the World Bank. $\LaTeX$

Through the Python community I was aware of Zcash from before it launched and was interested in it from the beginning. I was aware of the problems with Bitcoin, thanks to hanging out near Zooko for a few hours. My first bit of crypto was $50 worth of Bitcoin to get some Zcash to play around with. My kid and I had a fun time mining a couple of Zcash with a GPU from *large retail outlet*.

- Admired Zooko and other hackers 2008 ->
- Met Zooko and hung out ~2012
- Got involved a bit starting in 2016
- Did some early Bay Area in person meetups, met Nathan, had a beer
- Wrote a trading bot and private website that has been running like a boss for almost 6 years

### Meanwhile

Career and family. Full-stack web developer. Senior for about 12 years. Something more now:

- Django consulting for private schools and small businesses
- Django/Postgis models for The World Bank
- Django CMS for Transgaming's GameTreeTV
- Django PaaS for JPMC (saw Zcash logo in office when Amber came through town)
- Chase.com frontend build systems
- SAP Multi Cloud - Go, Python, TypeScript, Cloud Automation - AWS, Azure, GCP, Alicloud

## Free2z?

Free2z.cash in a nutshell:

> A platform for sharing content and raising funds privately and anonymously (if desired)

### Why?

One of my hobbies is thinking about cool stuff that I might be able to do with Zcash but then deciding not to execute on them. 
Free2z is like my $15^{th}$ idea for Zcash.
Most of these ideas have a fatal flaw, the main one being *Custody*:

1. Custody: any bit of custody brings into play a whole mountain of laws, regulations and licensing fees that I'm not interested in.
1. Complexity: crypto is too much of a hassle for me and my mom
1. No real addition to shielded pool usage
1. Just another centralized service
1. Not fun enough!

Any idea I try to go forward with would have to:

1. Have no element of custody
1. Be simple enough for me and my mom to use everyday
1. Make new people who have never heard of Zcash want to dive into the shielded pool
1. Have some decentralized/FOSS legs to stand on
1. Use features _unique_ to Zcash
1. Be fun!

There are a few things that constantly remind me of Zcash:

- My favorite podcasters asks me to go to some website to pay a big credit card fee and put my PII in some database to support them (waves fist at sky cursing credit card companies)
- People get deboosted and banned from legacy social media
- I hear about a charity or initiative I want to support
- Any time I buy something on the internet
- A new law, regulation emerges that further erodes digital privacy
- Any revelation of a data breach

> Note: I don't like computers, banks, credit cards, legacy social media😃. Basically nothing can provoke me to get my credit card out and sign up for a new website.

## The Idea for Free2z

With these nagging thoughts, I often ponder how I might be able to do something
to get people into the shielded pool.
The idea for Free2z hit me the evening of February 23rd, 2022
and I knew I had to make a working proof-of-concept.

![Free2z architecture](https://pbs.twimg.com/media/FPZ3h39XIAEDECw?format=jpg&name=small)

This is how it goes:

- Anyone can come to the site and create a zPage with rich content (F2Z-flavored markdown) - whether they have Zcash or not
- Once page is funded (0.001 ZEC), creator can publish to the unauthenticated and add their own zaddress (or other type of address)
- Unauthenticated users can message and fund creators p2p via Zcash network (or other choice)
- Unauthenticated users can comment with ZIP-321 on the blockchain
- Unauthenticated users can upvote (and soon downvote pages)
- Creators who are authenticated and funded can see unfunded pages

### Onchain versus offchain

There are some things that traditional webapps are good at:

- authentication/authorization/session
- 


## Pages to highlight

My own dogfood:

- F2Z-flavored markdown: [https://free2z.cash/flavored-markdown](https://free2z.cash/flavored-markdown)
- Python Zcash RPC: [https://free2z.cash/python-zcash-rpc](https://free2z.cash/python-zcash-rpc)