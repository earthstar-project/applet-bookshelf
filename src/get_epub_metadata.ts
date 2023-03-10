import {
  BlobWriter,
  TextWriter,
  ZipReader,
} from "https://deno.land/x/zipjs@v2.6.60/index.js";
const parser = new DOMParser();

export type EpubMetadata = {
  title: string;
  creators: string[] | undefined;
  language: string;
  identifiers: { kind: string; id: string }[];
  date: Date | undefined;
  cover: Blob | undefined;
};

export async function getEpubMetadata(
  readable: ReadableStream<Uint8Array>,
): Promise<EpubMetadata> {
  const zipReader = new ZipReader(readable);

  const entries = await zipReader.getEntries();

  const metaInfContainerEntry = entries.find((entry) =>
    entry.filename === "META-INF/container.xml"
  );

  if (!metaInfContainerEntry) {
    throw new Error("Couldn't get META-INF/container");
  }

  const containerTextWriter = new TextWriter();

  await metaInfContainerEntry.getData(containerTextWriter);

  const containerXml = await containerTextWriter.getData();

  const containerXmlParsed = parser.parseFromString(containerXml, "text/xml");

  const firstRootFileEl = containerXmlParsed.getElementsByTagName("rootfile")
    .item(0);
  const fullPath = firstRootFileEl?.getAttribute("full-path");

  if (!fullPath) {
    throw "Couldn't get root file full path";
  }

  const rootFileEntry = entries.find((entry) => entry.filename === fullPath);

  if (!rootFileEntry) {
    throw new Error("Root file not found!");
  }

  const rootFileTextWriter = new TextWriter();

  await rootFileEntry.getData(rootFileTextWriter);

  const rootfileXml = await rootFileTextWriter.getData();

  const rootFileParsed = parser.parseFromString(rootfileXml, "text/xml");

  const metadataEl = rootFileParsed.getElementsByTagName("package").item(0)
    ?.getElementsByTagName("metadata")?.item(0);

  if (!metadataEl) {
    throw new Error("Couldn't find epub metadata in OPF!");
  }

  const title = metadataEl.getElementsByTagName("dc:title").item(0)
    ?.textContent;

  if (!title) {
    throw new Error("Couldn't parse required metadata: title");
  }

  const creators = [];

  for (const creator of metadataEl.getElementsByTagName("dc:creator")) {
    creators.push(creator.textContent as string);
  }

  const language = metadataEl.getElementsByTagName("dc:language").item(0)
    ?.textContent;

  if (!language) {
    throw new Error("Couldn't parse required metadata: language");
  }

  const identifiers: { kind: string; id: string }[] = [];

  for (const el of metadataEl.getElementsByTagName("dc:identifier")) {
    const id = el.textContent;
    const kind = el.getAttribute("opf:scheme") || el.getAttribute("id");

    if (id && kind) {
      identifiers.push({ id, kind });
    }
  }

  if (identifiers.length === 0) {
    throw new Error("Couldn't parse required metadata: identifiers");
  }

  const dateText = metadataEl.getElementsByTagName("dc:date").item(0)
    ?.textContent;

  const date = dateText ? new Date(dateText) : undefined;

  const metadata: EpubMetadata = {
    title,
    creators: creators.length > 0 ? creators : undefined,
    language,
    identifiers,
    date,
    cover: undefined,
  };

  const manifestEl = rootFileParsed.getElementsByTagName("package").item(0)
    ?.getElementsByTagName("manifest")?.item(0);

  if (!manifestEl) {
    return metadata;
  }

  const coverItem = manifestEl.querySelector('item[id="cover"]');

  const coverHref = coverItem?.getAttribute("href");

  const coverMimeType = coverItem?.getAttribute("media-type");

  if (!coverItem || !coverHref || !coverMimeType) {
    return metadata;
  }

  if (coverMimeType.startsWith("image/")) {
    const coverBlobWriter = new BlobWriter(coverMimeType);

    const coverZipEntry = entries.find((entry) =>
      entry.filename.endsWith(coverHref)
    );

    if (!coverZipEntry) {
      return metadata;
    }

    await coverZipEntry.getData(coverBlobWriter);

    metadata.cover = await coverBlobWriter.getData();
  } else if (coverMimeType === "application/xhtml+xml") {
    const coverTextWriter = new TextWriter();

    const coverZipEntry = entries.find((entry) =>
      entry.filename.endsWith(coverHref)
    );

    if (!coverZipEntry) {
      return metadata;
    }

    await coverZipEntry.getData(coverTextWriter);

    const coverXmlString = await coverTextWriter.getData();

    const coverParsed = parser.parseFromString(
      coverXmlString,
      "application/xhtml+xml",
    );

    const image = coverParsed.querySelector("img");

    const src = image?.getAttribute("src");

    if (!image || !src) {
      return metadata;
    }

    const derelativised = src.replace("../", "");

    const coverBlobWriter = new BlobWriter();

    const coverImageZipEntry = entries.find((entry) =>
      entry.filename.endsWith(derelativised)
    );

    if (!coverImageZipEntry) {
      return metadata;
    }

    await coverImageZipEntry.getData(coverBlobWriter);

    metadata.cover = await coverBlobWriter.getData();
  }

  return metadata;
}
