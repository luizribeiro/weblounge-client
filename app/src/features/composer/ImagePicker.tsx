interface ImagePickerProps {
  readonly inputRef: (input: HTMLInputElement) => void;
  readonly onPick: (file: File) => void;
}

/** The hidden single-image input behind `/file`; click it only inside the user's gesture. */
export function ImagePicker(props: ImagePickerProps) {
  return (
    <input
      accept="image/*"
      data-image-picker="true"
      hidden
      onChange={(event) => {
        const input = event.currentTarget;
        const file = input.files?.[0];
        input.value = "";
        if (file !== undefined) props.onPick(file);
      }}
      ref={props.inputRef}
      tabIndex={-1}
      type="file"
    />
  );
}
