import styles from "./Picker.module.css";

/**
 * A row of mutually exclusive choices.
 *
 * WHY IT EXISTS. Three screens each grew their own version of this — a flex row of
 * buttons with the font size, padding, radius, border and both colours written inline,
 * slightly differently each time, twenty-odd lines of duplicated styling per screen. It
 * is one control appearing three times, so it is one component.
 *
 * SEGMENTED RATHER THAN SPACED APART. These are one choice with several answers, and
 * buttons with gaps between them read as several independent switches.
 */

interface Option<T extends string> {
  id: T;
  label: string;
  /** Shown under the label. Use for the human name when the id is a code. */
  sub?: string;
  /** Hover text. Never required reading — the label has to stand on its own. */
  hint?: string;
}

interface Props<T extends string> {
  /** Names the group for a screen reader, and is shown to everyone else. */
  label: string;
  options: Option<T>[];
  value: T;
  onChange: (next: T) => void;
}

export function Picker<T extends string>({ label, options, value, onChange }: Props<T>) {
  return (
    <div className={styles.wrap}>
      <span className={styles.label} id={`picker-${label.replace(/\s+/g, "-")}`}>
        {label}
      </span>
      <div
        className={styles.group}
        role="group"
        aria-labelledby={`picker-${label.replace(/\s+/g, "-")}`}
      >
        {options.map((option) => (
          <button
            key={option.id}
            className={option.id === value ? styles.optionOn : styles.option}
            onClick={() => onChange(option.id)}
            title={option.hint}
            aria-pressed={option.id === value}
          >
            <span className={styles.text}>{option.label}</span>
            {option.sub && <span className={styles.sub}>{option.sub}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
