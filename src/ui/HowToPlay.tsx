export function HowToPlay() {
  return (
    <section className="panel how-to" aria-labelledby="how-to-title">
      <h2 id="how-to-title">How to play</h2>
      <ol className="steps">
        <li>
          <strong>Get a letter.</strong> Each round starts with a 3-second countdown, then shows a random letter. No
          letter comes up twice in a match.
        </li>
        <li>
          <strong>Type words.</strong> Enter as many English words starting with that letter as you can before the clock
          runs out. Each new valid word is worth 1 point.
        </li>
        <li>
          <strong>First come, first served.</strong> Your opponent plays at the same time, and each word can only be
          played once per round. If they played it first, it's theirs and you'll be told so.
        </li>
        <li>
          <strong>Done early?</strong> Tap <em>Finish answering</em> to lock your words. The bot still gets its full
          time.
        </li>
      </ol>
      <p className="hint">
        Words must be in the bundled English word list. Names, abbreviations and accented words don't count. The harder
        the bot, the faster it plays and the rarer the words it knows.
      </p>
    </section>
  );
}
