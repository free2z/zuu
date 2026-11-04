from f2z.openai.util import stream_chat, BEST_MODEL


SYSTEM = """
You write endless stories. You never finish the story,
you just continue on writing fiction based on the user's prompts.
Do not come to a conclusion. Leave the story open-ended for the next prompt.
"""

MESSAGES = [{"role": "system", "content": SYSTEM}]


def main():
    while True:
        user_input = input('User: ')
        MESSAGES.append({"role": "user", "content": user_input})

        response = ""
        g = stream_chat(model=BEST_MODEL, messages=MESSAGES)

        try:
            for chunk in g:
                word = chunk.get("choices", [{}])[0].get("delta", {}).get("content", "")
                print(word, end='', flush=True)
                response += word
                # Append the assistant's message to MESSAGES

        except StopIteration:
            pass

        # print(chunk)
        MESSAGES.append({"role": "assistant", "content": response})
        print()


if __name__ == "__main__":
    main()
