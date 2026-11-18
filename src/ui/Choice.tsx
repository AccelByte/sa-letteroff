/** A row of segmented radio buttons. */
export interface ChoiceProps<T extends string | number> {
  legend: string;
  name: string;
  options: readonly T[];
  value: T;
  label: (option: T) => string;
  onChange: (option: T) => void;
}

export function Choice<T extends string | number>({ legend, name, options, value, label, onChange }: ChoiceProps<T>) {
  return (
    <fieldset className="choice">
      <legend>{legend}</legend>
      <div className="segmented">
        {options.map((option) => (
          <label key={option} className={option === value ? 'selected' : undefined}>
            <input
              type="radio"
              name={name}
              value={option}
              checked={option === value}
              onChange={() => onChange(option)}
            />
            {label(option)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
