const REGEX_URL = /url\(['"]?([^'"]+?)['"]?\)/g;
const REGEX_DATA_URL = /^(data:)/;

const MIME_TYPES = {
    woff: "application/font-woff",
    woff2: "application/font-woff",
    ttf: "application/font-truetype",
    eot: "application/vnd.ms-fontobject",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    tiff: "image/tiff",
    svg: "image/svg+xml",
    webp: "image/webp",
};

async function toCanvas(
    node: HTMLElement | SVGElement | MathMLElement,
    options?: {
        backgroundColor?: string;
    }
) {
    const svg = await toSvg(node, options);

    const image = await createImage(svg);

    const canvas = document.createElement("canvas");
    canvas.width = node.scrollWidth;
    canvas.height = node.scrollHeight;

    const ctx = canvas.getContext("2d")!;

    if (options?.backgroundColor) {
        ctx.fillStyle = options.backgroundColor;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    ctx.drawImage(image, 0, 0);

    return canvas;
}

async function toSvg(
    node: HTMLElement | SVGElement | MathMLElement,
    options?: {
        backgroundColor?: string;
    }
) {
    const clone = await cloneNode(node);

    await embedFonts(clone);

    if (options?.backgroundColor) {
        clone.style.backgroundColor = options.backgroundColor;
    }

    clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");

    const width = node.scrollWidth;
    const height = node.scrollHeight;

    const xhtml = new XMLSerializer()
        .serializeToString(clone)
        .replace(/#/g, "%23")
        .replace(/\n/g, "%0A");

    return `data:image/svg+xml;charset=utf-8,\
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">\
<foreignObject x="0" y="0" width="100%" height="100%">\
${xhtml}\
</foreignObject>\
</svg>`;
}

async function cloneNode<N extends Node>(node: N): Promise<N> {
    const clone = (
        node instanceof HTMLCanvasElement
            ? await createImage(node.toDataURL())
            : node.cloneNode(false)
    ) as N;

    for (let i = 0; i < node.childNodes.length; i++) {
        const child = node.childNodes[i];
        if (child) {
            // NOTE: recursion here
            clone.appendChild(await cloneNode(child));
        }
    }

    if (!isElement(clone) || !isElement(node)) {
        return clone;
    }

    // NOTE: clone CSS
    const style = window.getComputedStyle(node);

    if (style.cssText) {
        clone.style.cssText = style.cssText;
    } else {
        for (let i = 0; i < style.length; i++) {
            const prop = style[i];

            clone.style.setProperty(
                prop,
                style.getPropertyValue(prop),
                style.getPropertyPriority(prop)
            );
        }
    }

    // NOTE: clone pseudo elements
    for (const pseudo of [":before", ":after"]) {
        const pseudoStyle = window.getComputedStyle(node, pseudo);
        const content = pseudoStyle.getPropertyValue("content");

        if (content === "" || content === "none") {
            continue;
        }

        const className = "A" + (Date.now() + Math.random()).toString(36);
        clone.classList.add(className);

        let cssText = "";

        if (pseudoStyle.cssText) {
            cssText = pseudoStyle.cssText + " content:" + content + ";";
        } else {
            for (let i = 0; i < pseudoStyle.length; i++) {
                const prop = pseudoStyle[i];

                cssText +=
                    prop +
                    ":" +
                    pseudoStyle.getPropertyValue(prop) +
                    (pseudoStyle.getPropertyPriority(prop)
                        ? " !important"
                        : "") +
                    ";";
            }
        }

        const style = document.createElement("style");
        style.append("." + className + ":" + pseudo + "{" + cssText + "}");
        clone.appendChild(style);
    }

    // NOTE: clone user input
    if (node instanceof HTMLTextAreaElement) {
        clone.innerHTML = node.value;
    }
    if (node instanceof HTMLInputElement) {
        clone.setAttribute("value", node.value);
    }

    // NOTE: fix SVGs
    if (node instanceof SVGElement) {
        clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");

        if (node instanceof SVGRectElement) {
            const width = clone.getAttribute("width");
            if (width) {
                clone.style.setProperty("width", width);
            }

            const height = clone.getAttribute("height");
            if (height) {
                clone.style.setProperty("height", height);
            }
        }
    }

    await embedImages(clone);

    return clone;
}

async function embedFonts(node: Node): Promise<void> {
    let cssText = "";

    for (const sheet of document.styleSheets) {
        try {
            for (const rule of sheet.cssRules) {
                if (
                    rule.type === CSSRule.FONT_FACE_RULE &&
                    REGEX_URL.test(
                        // @ts-ignore TODO: check rule.style
                        rule.style.getPropertyValue("src")
                    )
                ) {
                    cssText += await resolveURLs(
                        rule.cssText,
                        rule.parentStyleSheet?.href!
                    );
                    cssText += "\n";
                }
            }
        } catch (error) {
            console.error("Error reading CSS style sheet", sheet, error);
        }
    }

    if (cssText) {
        const style = document.createElement("style");
        style.append(cssText);
        node.appendChild(style);
    }
}

async function embedImages(node: Node): Promise<void> {
    if (!isElement(node)) {
        return;
    }

    const background = node.style.getPropertyValue("background");

    if (REGEX_URL.test(background)) {
        node.style.setProperty(
            "background",
            await resolveURLs(background),
            node.style.getPropertyPriority("background")
        );
    }

    if (node instanceof HTMLImageElement) {
        if (REGEX_DATA_URL.test(node.src)) {
            return;
        }

        if (!node.src) {
            console.error("Image has no src", node);
            return;
        }

        const src = node.src;

        try {
            const data = await fetchURL(src);
            const ext = src.split(".").pop()!.toLowerCase();

            await new Promise((resolve, reject) => {
                node.onload = resolve;
                node.onerror = reject;
                node.src = "data:" + MIME_TYPES[ext] + ";base64," + data;
            });
        } catch (error) {
            console.error("Error loading image src:", src, error);
        }
    }
}

async function resolveURLs(str: string, baseUrl?: string): Promise<string> {
    if (!REGEX_URL.test(str)) {
        return str;
    }

    let match: RegExpMatchArray | null;

    while ((match = REGEX_URL.exec(str)) !== null) {
        const _url = match[1];

        if (REGEX_DATA_URL.test(_url)) {
            continue;
        }

        const url = baseUrl ? fixURL(_url, baseUrl) : _url;

        try {
            const data = await fetchURL(url);
            const ext = url.split(".").pop()!.toLowerCase();

            str = str.replace(
                new RegExp(
                    // NOTE: replace url(URL), url("URL"), url('URL')
                    // background: url(https://example.com/example.png) -> background: data:image/png;base64,RGlvY2Fu=...
                    "(url\\(['\"]?)(" +
                        url.replace(
                            // NOTE: escape URL for regex
                            // https://example.com -> https:\\/\\/example\\.com
                            /([.*+?^${}()|\[\]\/\\])/g,
                            "\\$1"
                        ) +
                        ")(['\"]?\\))",
                    "g"
                ),
                "data:" + MIME_TYPES[ext] + ";base64," + data
            );
        } catch (error) {
            console.error("Error fetching url:", url, error);
        }
    }

    return str;
}

async function fetchURL(url: string): Promise<string> {
    const res = await fetch(url);

    if (!res.ok) {
        throw res;
    }

    const blob = await res.blob();

    const encoder = new FileReader();

    return await new Promise<string>((resolve, reject) => {
        encoder.onloadend = () => {
            resolve(encoder.result!.toString().split(/,/)[1]);
        };
        encoder.onerror = reject;
        encoder.readAsDataURL(blob);
    });
}

function fixURL(url: string, baseUrl: string): string {
    const _document = document.implementation.createHTMLDocument();

    const base = _document.createElement("base");
    _document.head.appendChild(base);

    const a = _document.createElement("a");
    _document.body.appendChild(a);

    base.href = baseUrl;
    a.href = url;

    return a.href;
}

function isElement(
    node: Node
): node is HTMLElement | SVGElement | MathMLElement {
    return (
        node instanceof HTMLElement ||
        node instanceof SVGElement ||
        node instanceof MathMLElement
    );
}

function createImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = (error) => {
            console.error("Error loading image:", error, image);
            resolve(new Image());
        };
        image.src = src;
    });
}
