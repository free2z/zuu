// DEPRECATED just used because of imports

export const SUCCESS_MESSAGES = [
    "me gusta, mucho!",
    "Boom goes the dynamite",
    "Oh wow, big spender",
    "Yes, right there",
    "Got 'em",
    "We'll get right on that",
    "You're the best",
    "You're a real one",
    "Legend",
    "Heck yes!",
    "That's the spirit!",
    "Alright!",
    "Feeling it.",
    "GMI",
    "Fantastic!",
    "You got this",
    "Let's rock",
    "Can't wait to see where you go with this",
    "Freedom ain't free!",
]

export const getRando = (array: Array<string>) => {
    return array[Math.floor(Math.random() * array.length)];
}
