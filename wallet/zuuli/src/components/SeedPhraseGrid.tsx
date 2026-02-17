interface Props {
  phrase: string;
}

export function SeedPhraseGrid({ phrase }: Props) {
  const words = phrase.split(" ");

  return (
    <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
      {words.map((word, i) => (
        <div
          key={i}
          className="bg-zinc-900 border border-zinc-800 hover:border-zinc-600 rounded-lg px-3 py-2.5 text-sm transition-colors"
        >
          <span className="text-zinc-500 mr-2 text-xs">{i + 1}.</span>
          <span className="text-white font-mono">{word}</span>
        </div>
      ))}
    </div>
  );
}
