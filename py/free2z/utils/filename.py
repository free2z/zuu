def limit_filename_length(filename, max_length=60):
    # Ensure the filename is a string
    if not isinstance(filename, str):
        raise ValueError("Filename must be a string.")

    # Ensure max_length is an integer
    if not isinstance(max_length, int):
        raise ValueError("Max length must be an integer.")

    # Check if the filename has an extension
    if '.' in filename:
        # Split the filename into the name and extension
        name, extension = filename.rsplit('.', 1)

        # If the filename is longer than max_length, shorten it
        if len(filename) > max_length:
            allowed_name_length = max_length - len(extension) - 1
            name = name[:allowed_name_length]

        # Join the shortened name and the extension
        return f"{name}.{extension}"
    else:
        # If the filename doesn't have an extension, just shorten it
        return filename[:max_length]
