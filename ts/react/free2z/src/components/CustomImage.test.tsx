import "@testing-library/jest-dom";
import { render } from "@testing-library/react";

import CustomImage from "./CustomImage";

describe("CustomImage", () => {
    it("preserves Markdown hover text on the inline and lightbox images", () => {
        const { container } = render(
            <CustomImage
                src="/example.jpg"
                alt="Alternative text"
                title="Alternative title"
            />
        );

        const images = container.querySelectorAll("img");
        expect(images).toHaveLength(2);
        images.forEach((image) => {
            expect(image).toHaveAttribute("title", "Alternative title");
        });
    });
});
