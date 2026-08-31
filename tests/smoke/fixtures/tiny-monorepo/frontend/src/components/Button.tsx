type Props = { onClick: () => void };

export default function Button({ onClick }: Props) {
  return (
    // DELIBERATE DEFECT for ux-design-review:
    // Icon-only button with no aria-label, no visible text.
    // Screen readers announce nothing meaningful.
    <button onClick={onClick}>
      <svg width="16" height="16" viewBox="0 0 16 16">
        <circle cx="8" cy="8" r="6" />
      </svg>
    </button>
  );
}
