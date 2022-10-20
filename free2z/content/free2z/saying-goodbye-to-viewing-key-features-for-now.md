# Viewing key features

We implemented a really cool proof-of-concept: using 
viewing keys to have goals, polls and transparent fundraising.
One of the most successful pages was 
[the MIT of BOSL poll](https://free2z.cash).

## The Editing Interface

The editing interface looked like this:

::embed[https://i.ibb.co/T0NsmpM/Screen-Shot-2022-07-16-at-2-44-58-PM.png]

You can see the purple eyeball, checkered flag and bar graph
representing "viewing key", "goal" and poll.
These buttons opened up modals that looked like this:

::embed[https://ibb.co/30ttLkD]

::embed[https://ibb.co/9v70SzW]

::embed[https://ibb.co/zH0Lfqd]

## Rendering the Viewing Key data

With a viewing key, a goal and a poll all in place,
the interface looked like this:

Progress bar for goal:

::embed[https://ibb.co/R0nb0ck]

Poll results:

::embed[https://ibb.co/xFYRP5f]

Transparent fundraising for a good cause:

::embed[https://ibb.co/mXg5Ff1]

# Decision to remove

We were incredibly proud of our unique onchain viewing-key features.
But, we are removing the features for the following reasons:

1. Difficult or impossible to scale (for now)
2. Potentially confusing for all but the most sophisticated users
3. Not necessary for the viral success of free2z or Zcash
4. Not part of our grant proposal
5. Focus on making the core features easy and robust

One of the main goals of free2z is to get people using
private internet cash *peer-to-peer* in the easiest, most user-friendly way possible.
Although we feel the viewing key features on free2z were an impressive
flex showing what may be possible in the future with Zcash,
for now they are a 
[bike-shed](https://en.wikipedia.org/wiki/Law_of_triviality) that distracts from the core mission of empowering people with Private Internet Cash.
In order to scale, it was even suggested that free2z could act as an
intermediary, [holding funds on behalf of users to display progress](https://discord.com/channels/669694001464737815/678658481787633675/997309377239326791)!
After a brief moment of consideration, holding Creator's funds in
custody is against the core mission of free2z.
Scaling cool features is not worth discarding the core mission!
We will however look into bringing back these advanced features in the future
when we can simply integrate them into easy and robust light wallets!