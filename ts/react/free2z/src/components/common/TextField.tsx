import MaterialTextField, { TextFieldProps as MaterialTextFieldProps } from "@mui/material/TextField"

type TextFieldProps = MaterialTextFieldProps & {};

export default function TextField({ ...props }: TextFieldProps) {
  return (
    <MaterialTextField
      {...props}
    />
  )
}
