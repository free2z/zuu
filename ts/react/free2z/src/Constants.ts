import { Buffer } from 'buffer';

// TODO: make dynamic
// export const current_f2z_address = "zs16d60pj9ws682ewchraejujscf4crsuatyc83gzwnlgzzyphc3ydhynqv9p40gygnts83cfy5q23"
// export const current_f2z_address = "zs1wkh9qdpznatw07gfv3xf0ewed0hhqp9vjt02kcmckz7jfxet7ld3ujldzlcke8a5fympvvndp39"
export const current_f2z_address = "zs1lm4vumxdpuz08w237n0lpxz490uq5nxasz6mql555f96hql4h7kc3ucf2a42j7mp0slck2uvjjk"

export function getURI(
    address: string,
    amount: string,
    memo: string,
) {
    if (address.startsWith('t')) {
        return `zcash:${address}?amount=${amount}`;
    } else {
        const memo64 = Buffer.from(memo, 'utf-8')
            .toString('base64')
            .replaceAll('=', '')
            .replaceAll('+', '-')
            .replaceAll('/', '_');
        return `zcash:${address}?amount=${amount}&memo=${memo64}`;
    }
}

export const categoryChoices = [
    "Art",
    "Charity",
    "Comedy",
    "Community",
    "Crypto",
    "Education",
    "Fiction",
    "For Trade",
    "Free2z",
    "Fundraising",
    "Gaming",
    "Health",
    "Lifestyle",
    "Math",
    "Music",
    "Podcast",
    "Politics",
    "Relief",
    "Science",
    "Service",
    "Sports",
    "Technology",
    "Zcash",
]

export const subMess = [
    "Freedom ain't free",
    "Freedom ain't free",
    "Together we win",
    "Together we win",
    "Make it happen",
    "Make it happen",
    "Free2 find your Z",
    "Make it happen with F2Z",
    "Have you seen Free2z lately?",
    "You are now free to Z!",
    "What is your Z?",
    "Freedom is important",
    "Thanks for building a better future",
    "Have fun with your friends and family",
    "Wow; pretty cool",
    "Free to Give",
    "Free to Give",
    "Free to Engage",
    "Free to Grow",
    "Free to Express",
    "Free to Express",
    "Free to Win",
    "Free to Heal",
    "Free to Grow",
    "Free to Grow",
    "Free to Grow",
    "Free to Praise",
    "Free to Praise",
    "Free to Love",
    "Free to Communicate",
    "Free to Interact",
    // "Escape the Matrix",
    "You can be healthy and strong",
    "Privacy is a human right",
    "Privacy is a human right",
    "Privacy is a human right",
    "Privacy is a human right",
    "Privacy is a human right",
    "Privacy is a human right",
    "Privacy is a human right",
    "Tell a friend",
]

export function getRandom() {
    return subMess[Math.floor(Math.random() * subMess.length)];
}


export const samplePage = `# Welcome to Free2Z-Flavored Markdown

Free2Z-Flavored Markdown is an enhanced version of standard markdown with additional features and syntax. It includes all the features of standard markdown, such as headings, lists, links, and emphasis, as well as additional features that make it stand out.

## Uploads

With the Free2Z-Flavored Markdown toolbar, you can easily upload and embed videos, images, and other types of files. Simply click on the "upload" button and select the file you want to upload.

## Embeds

Free2Z-Flavored Markdown also includes a special syntax for embedding content from other websites. To embed a video, image, map, or any other type of content, you can use the \`::embed[URL]\` syntax.

For example, to embed a YouTube video, you can use the following code:

::embed[https://www.youtube.com/watch?v=xUcB90b2HMs]

## Code Blocks

To create a code block, you can use three backticks (\`\`\`) before and after the code. Optionally, you can specify the language of the code to enable syntax highlighting.

\`\`\`js
const example = 'code block';
console.log(example);
\`\`\`

## LaTeX Math

You can insert inline math by enclosing it two dollar signs (\`$$\`), and display math by enclosing it in two dollar signs (\`$$\`) _on their own lines_.

For example, the equation for a straight line is $$y = mx + b$$, and the Pythagorean theorem is

$$
a^2 + b^2 = c^2
$$

Learn more about Free2Z-Flavored Markdown by visiting our website [Free2Z.cash](https://free2z.cash/flavored-markdown)

>TODO: Add video tutorial of Free2Z-Flavored Markdown

`
