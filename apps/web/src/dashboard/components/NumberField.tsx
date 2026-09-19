export function NumberField({
  label,
  unit,
  value,
  onChange,
  disabled,
  min,
  max,
  step = '1',
}: {
  label: string;
  unit: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  min: string;
  max: string;
  step?: string;
}) {
  return (
    <label className="setting-field">
      <span>{label}</span>
      <span className="input-with-unit">
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
        <small>{unit}</small>
      </span>
    </label>
  );
}
