import {
  AuthorAddress,
  AuthorKeypair,
  Crypto,
  DocEs5,
  extractTemplateVariablesFromPath,
  isErr,
  Peer,
  Replica,
  ReplicaDriverWeb,
  ShareAddress,
  SharedSettings,
} from "earthstar";
import { EpubMetadata, getEpubMetadata } from "./get_epub_metadata.ts";

export type BookItem = EpubMetadata & {
  uploader: string;
  sha256hash: string;
};

// /books/~${settings.author.address}/${epubHash}/doc.epub

export class BookIndex {
  private replica: Replica;
  // Key = {authorAddress}_{epubSha256}
  private indexByPath = new Map<string, BookItem>();
  private onUpdatedCbs = new Set<() => void>();

  constructor(replica: Replica) {
    // query index...
    this.replica = replica;

    const { indexByPath, onUpdatedCbs } = this;

    replica.getEventStream("attachment_ingest").pipeTo(
      new WritableStream({
        write(event) {
          if (event.kind === "attachment_ingest") {
            const { doc } = event;

            const isForBook = doc.path.startsWith("/books/~") &&
              doc.path.endsWith("/doc.epub");

            if (!isForBook) {
              return;
            }

            const template = `/books/~{authorAddress}/{epubHash}/doc.epub`;

            replica.getAttachment(doc as DocEs5).then(
              async (attachmentRes) => {
                if (isErr(attachmentRes) || attachmentRes === undefined) {
                  return;
                }

                try {
                  const metadata = await getEpubMetadata(
                    await attachmentRes.stream(),
                  );

                  const variables = extractTemplateVariablesFromPath(
                    template,
                    doc.path,
                  );

                  if (variables === null) {
                    return;
                  }

                  indexByPath.set(
                    `${variables["authorAddress"]}_${variables["epubHash"]}`,
                    {
                      ...metadata,
                      uploader: doc.author,
                      sha256hash: variables["epubHash"],
                    },
                  );

                  for (const cb of onUpdatedCbs) {
                    cb();
                  }
                } catch {
                  return;
                }
              },
            );
          }
        },
      }),
    );

    replica.getQueryStream({
      filter: {
        pathStartsWith: "/books/~",
        pathEndsWith: "/doc.epub",
      },
    }, "everything").pipeTo(
      new WritableStream({
        write(event) {
          if (
            event.kind === "expire" || event.kind === "processed_all_existing"
          ) {
            return;
          }

          // Update the book
          const { doc } = event;

          const template = `/books/~{authorAddress}/{epubHash}/doc.epub`;

          if (doc.text === "" && doc.attachmentSize === 0) {
            // Remove this book.
            const variables = extractTemplateVariablesFromPath(
              template,
              doc.path,
            );

            if (variables === null) {
              return;
            }

            indexByPath.delete(
              `${variables["authorAddress"]}_${variables["epubHash"]}`,
            );

            for (const cb of onUpdatedCbs) {
              cb();
            }
            return;
          }

          replica.getAttachment(doc).then(
            async (attachmentRes) => {
              if (isErr(attachmentRes) || attachmentRes === undefined) {
                return;
              }

              try {
                const metadata = await getEpubMetadata(
                  await attachmentRes.stream(),
                );

                const variables = extractTemplateVariablesFromPath(
                  template,
                  doc.path,
                );

                if (variables === null) {
                  return;
                }

                indexByPath.set(
                  `${variables["authorAddress"]}_${variables["epubHash"]}`,
                  {
                    ...metadata,
                    uploader: doc.author,
                    sha256hash: variables["epubHash"],
                  },
                );

                for (const cb of onUpdatedCbs) {
                  cb();
                }
              } catch {
                return;
              }
            },
          );
        },
      }),
    );
  }

  async getBookBytes(author: AuthorAddress, bookHash: string) {
    const bookPath = `/books/~${author}/${bookHash}/doc.epub`;

    const bookDoc = await this.replica.getLatestDocAtPath(bookPath);

    if (!bookDoc) {
      return undefined;
    }

    const bookAttachment = await this.replica.getAttachment(bookDoc);

    if (!bookAttachment || isErr(bookAttachment)) {
      return undefined;
    }

    return bookAttachment.bytes();
  }

  getAllBooks(): BookItem[] {
    return Array.from(this.indexByPath.values());
  }

  onIndexUpdated(cb: () => void): () => void {
    this.onUpdatedCbs.add(cb);

    return () => {
      this.onUpdatedCbs.delete(cb);
    };
  }

  async close() {
    await this.replica.close(false);
  }

  async addBook(author: AuthorKeypair, stream: ReadableStream<Uint8Array>) {
    const [forMetadata, forTeeingAgain] = stream.tee();

    const metadata = await getEpubMetadata(forMetadata);

    const [forAttachment, forHashing] = forTeeingAgain.tee();

    const updatableHash = Crypto.updatableSha256();

    await forHashing.pipeTo(
      new WritableStream({
        write(chunk) {
          updatableHash.update(chunk);
        },
      }),
    );

    const epubHash = await Crypto.sha256base32(updatableHash.digest());

    const result = await this.replica.set(author, {
      text: `Epub: ${metadata.title} by ${
        metadata.creators?.join(", ") || "unknown"
      }`,
      path: `/books/~${author.address}/${epubHash}/doc.epub`,
      attachment: forAttachment,
    });

    if (isErr(result)) {
      throw result;
    }
  }

  async removeBook(author: AuthorKeypair, epubHash: string) {
    const path = `/books/~${author.address}/${epubHash}/doc.epub`;

    await this.replica.wipeDocAtPath(author, path);
  }
}

export class BookIndexes {
  private indexes = new Map<ShareAddress, BookIndex>();
  private settings: SharedSettings;

  peer = new Peer();

  constructor() {
    this.settings = new SharedSettings();

    console.log("?");

    for (const share of this.settings.shares) {
      const shareSecret = this.settings.shareSecrets[share];

      const replica = new Replica({
        driver: new ReplicaDriverWeb(share),
        shareSecret,
      });

      this.peer.addReplica(replica);

      const index = new BookIndex(replica);

      this.indexes.set(share, index);
    }

    this.settings.onSharesChanged((nextShares) => {
      for (const share of nextShares) {
        if (!this.indexes.has(share)) {
          this.addShare(share);
        }
      }

      for (const [shareAddress, index] of this.indexes) {
        if (!nextShares.includes(shareAddress)) {
          index.close().then(() => {
            this.indexes.delete(shareAddress);
          });
          this.peer.removeReplicaByShare(shareAddress);
        }
      }
    });

    for (const server of this.settings.servers) {
      console.log(server);

      const syncer = this.peer.sync(server, true);

      syncer.isDone().catch(() => {
        console.log("caught");
      });
    }
  }

  addShare(address: ShareAddress) {
    const shareSecret = this.settings.shareSecrets[address];

    const replica = new Replica({
      driver: new ReplicaDriverWeb(address),
      shareSecret,
    });

    this.peer.addReplica(replica);

    const index = new BookIndex(replica);

    this.indexes.set(address, index);
  }

  getIndex(address: ShareAddress) {
    return this.indexes.get(address);
  }
}
