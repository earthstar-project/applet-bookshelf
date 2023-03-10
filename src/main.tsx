import { render } from "preact";
import {
  signal,
  useComputed,
  useSignal,
  useSignalEffect,
} from "@preact/signals";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ShareAddress, SharedSettings } from "earthstar";
import { Listbox } from "@headlessui/react";
import { AuthorLabel, ShareLabel } from "react-earthstar";
import { BookIndex, BookIndexes, BookItem } from "./book_index.ts";

import "./applet.css";

import { EpubMetadata, getEpubMetadata } from "./get_epub_metadata.ts";

const settings = new SharedSettings();

// Current share...
const selectedShare = signal<ShareAddress | null>(null);

const currentAuthor = signal(settings.author);

settings.onAuthorChanged((newAuthor) => {
  currentAuthor.value = newAuthor;
});

const shares = signal(settings.shares);

settings.onSharesChanged((newShares) => {
  shares.value = newShares;
});

const secrets = signal(settings.shareSecrets);

settings.onShareSecretsChanged((newSecrets) => {
  secrets.value = newSecrets;
});

const bookIndexes = new BookIndexes();

function BookshelfApplet() {
  const summaryRef = useRef(null);

  return (
    <>
      <header>
        <details
          onClick={(e) => {
            console.log(e.target, summaryRef.current);

            if (e.target !== summaryRef.current) {
              e.preventDefault();
            }
          }}
        >
          <summary ref={summaryRef}>
            <h1 class="app-title">Bookshelf</h1>
            <ShareSelection />
          </summary>
          <p>
            This is an applet for adding and retrieving ePubs from a share. Book
            metadata is extracted from the ePubs automatically, and added ePubs
            are persisted locally for offline access.
          </p>
          <p>
            The ePubs you add are only synced to devices which know about this
            share.
          </p>
          <p>
            Choose a share to get started. If there are no known shares, add
            some using CinnamonOS.
          </p>
        </details>
      </header>
      <main class="app">
        <CommonServers />
        <BookListing />
        <BookUploader />
      </main>
    </>
  );
}

function CommonServers() {
  if (selectedShare.value === null) {
    return null;
  }

  const [serversWithShare, setServersWithShare] = useState<string[]>(
    [],
  );
  const [syncersCount, setSyncersCount] = useState(0);

  useSignalEffect(() => {
    setServersWithShare([]);

    const syncers = bookIndexes.peer.getSyncers();

    setSyncersCount(syncers.size);

    for (const [_id, { syncer, description }] of syncers) {
      if (syncer.isDone().state === "rejected") {
        setSyncersCount((prev) => prev - 1);

        continue;
      }

      const hasShare = Object.keys(syncer.getStatus()).includes(
        selectedShare.value || "",
      );

      console.log(description);

      if (hasShare) {
        setServersWithShare((prev) => {
          return [...prev, description];
        });
      }
    }
  });

  useEffect(() => {
    const syncerUnsubs: (() => void)[] = [];

    const unsub = bookIndexes.peer.onSyncersChange((syncers) => {
      setSyncersCount(syncers.size);

      for (const [_id, { syncer, description }] of syncers) {
        const syncerUnsub = syncer.onStatusChange((status) => {
          if (status[selectedShare.value || ""].docs.status === "aborted") {
            setSyncersCount((prev) => prev - 1);

            return;
          }

          const hasShare = Object.keys(status).includes(
            selectedShare.value || "",
          );

          if (hasShare) {
            setServersWithShare((prev) => {
              const set = new Set(prev);

              set.add(description);

              return Array.from(set);
            });
          } else {
            setServersWithShare((prev) => {
              const set = new Set(prev);

              set.delete(description);

              return Array.from(set);
            });
          }
        });

        syncerUnsubs.push(() => {
          syncerUnsub();

          setServersWithShare((prev) => {
            const set = new Set(prev);

            set.delete(description);

            return Array.from(set);
          });
        });
      }
    });

    return () => {
      unsub();

      for (const unsub of syncerUnsubs) {
        unsub();
      }
    };
  }, [bookIndexes]);

  if (syncersCount === 0) {
    return (
      <div className="not-syncing-servers">
        You're not syncing with anyone right now, so your changes will stay on
        this device.
      </div>
    );
  }

  if (serversWithShare.length === 0) {
    return (
      <div className="not-syncing-servers">
        <span>
          None of the servers you're syncing with know about{" "}
          <ShareLabel
            address={selectedShare.value!}
            viewingAuthorSecret={currentAuthor.value?.secret}
            iconSize={8}
          />
        </span>
      </div>
    );
  }

  return (
    <div className="syncing-servers">
      Syncing with
      {serversWithShare.map((server) => {
        return (
          <span key={server} className="syncing-server">{" "}{server}</span>
        );
      })}
    </div>
  );
}

function BookListing() {
  if (selectedShare.value === null) {
    return null;
  }

  const index = useComputed(() => {
    if (selectedShare.value === null) {
      return undefined;
    }

    return bookIndexes.getIndex(selectedShare.value);
  });

  if (!index.value) {
    return null;
  }

  const books = useSignal(index.value.getAllBooks());

  useSignalEffect(() => {
    books.value = index.value?.getAllBooks() || [];

    const unsub = index.value?.onIndexUpdated(() => {
      books.value = index.value?.getAllBooks() || [];
    });

    return unsub;
  });

  return (
    <fieldset class="book-list">
      <legend>
        Books on{" "}
        <ShareLabel
          address={selectedShare.value}
          viewingAuthorSecret={settings.author?.secret}
        />
      </legend>
      {books.value.length === 0
        ? <p>Nobody has added any books to this share yet.</p>
        : null}
      {books.value.map((book) => {
        return <BookListingItem key={book.sha256hash} item={book} />;
      })}
    </fieldset>
  );
}

function BookListingItem(
  { item, showControls = true, isNew = false }: {
    item: BookItem;
    showControls?: boolean;
    isNew?: boolean;
  },
) {
  if (selectedShare.value === null) {
    return null;
  }

  const index = bookIndexes.getIndex(selectedShare.value);

  if (!index) {
    return null;
  }

  const download = useEpubDownload(index);

  return (
    <div class={`book-item ${isNew ? "new-book" : ""}`}>
      <div>
        {item.cover
          ? (
            <img
              className="book-cover-img"
              src={URL.createObjectURL(item.cover)}
            />
          )
          : <div>No image!</div>}
      </div>
      <div>
        <div class="book-title">
          {item.title}
        </div>

        {item.creators ? <div>{`by ${item.creators.join(", ")}`}</div> : null}

        <div class="book-shared-by">
          {" "}shared by{" "}
          <AuthorLabel
            address={item.uploader}
            viewingAuthorSecret={settings.author?.secret || undefined}
          />
        </div>
        {showControls
          ? (
            <div class="book-item-controls">
              <button
                onClick={() => {
                  download(item);
                }}
              >
                Download
              </button>

              {item.uploader === settings.author?.address
                ? (
                  <button
                    onClick={() => {
                      if (!settings.author) {
                        return;
                      }

                      const isSure = confirm(
                        `Are you sure you want to delete ${item.title}?`,
                      );

                      if (!isSure) {
                        return;
                      }

                      index.removeBook(settings.author, item.sha256hash);
                    }}
                  >
                    Delete
                  </button>
                )
                : null}
            </div>
          )
          : null}
      </div>
    </div>
  );
}

function BookUploader() {
  if (selectedShare.value === null) {
    return null;
  }

  const secret = settings.shareSecrets[selectedShare.value];

  if (!secret || !settings.author) {
    return null;
  }

  const selectedFile = useSignal<File | null>(null);
  const metadata = useSignal<EpubMetadata | null>(null);
  const parseErrorMessage = useSignal<string | null>(null);

  const formRef = useRef<HTMLFormElement>(null);

  const isAddingEpub = useSignal(false);

  function resetForm() {
    metadata.value = null;
    selectedFile.value = null;
    parseErrorMessage.value = null;
    formRef.current?.reset();
  }

  return (
    <fieldset>
      <legend>
        Add an ePub as{" "}
        <AuthorLabel
          address={settings.author.address}
          viewingAuthorSecret={settings.author.secret}
        />
      </legend>
      <form
        class="upload-form"
        ref={formRef}
        onSubmit={async (e) => {
          e.preventDefault();

          if (
            !metadata.value || !selectedFile.value || parseErrorMessage.value ||
            !selectedShare.value || !settings.author
          ) {
            return;
          }

          const index = bookIndexes.getIndex(selectedShare.value);

          if (!index) {
            return;
          }

          await index.addBook(settings.author, selectedFile.value.stream());

          alert("Book was added.");

          resetForm();
        }}
      >
        <input
          type="file"
          accept=".epub"
          onInput={async (e) => {
            if (e.target === null) {
              return;
            }

            const target = e.target as HTMLInputElement;

            if (target.files === null) {
              return;
            }

            selectedFile.value = null;
            metadata.value = null;
            parseErrorMessage.value = null;

            const file = target.files[0];

            // Unzip the parts
            try {
              const epubMetadata = await getEpubMetadata(file.stream());

              selectedFile.value = file;
              metadata.value = epubMetadata;
            } catch (err) {
              // Not a valid epub, apparently.
              parseErrorMessage.value = "Could not parse ePub for metadata.";
            }
          }}
        />
        {metadata.value
          ? (
            <BookListingItem
              item={{
                ...metadata.value,
                uploader: settings.author.address,
                sha256hash: "madeupwhatever",
              }}
              showControls={false}
              isNew
            />
          )
          : null}
        {selectedFile.value && metadata.value
          ? (
            <div className="controls">
              <button type="submit" disabled={isAddingEpub.value}>
                Add ePub
              </button>
              <button
                onClick={() => {
                  resetForm();
                }}
                disabled={isAddingEpub.value}
              >
                Cancel
              </button>
            </div>
          )
          : null}
      </form>
    </fieldset>
  );
}

function ShareSelection() {
  function onSelectedShare(newShare: string) {
    selectedShare.value = newShare;
  }

  return (
    <div className="share-selection">
      <Listbox
        value={selectedShare.value}
        onChange={onSelectedShare}
        disabled={shares.value.length === 0}
      >
        <Listbox.Button className="listbox-button">
          <div className="selection-box">
            {shares.value.length === 0
              ? <span>No known shares</span>
              : selectedShare.value === null
              ? (
                <>
                  <span>
                    Select a share
                  </span>
                  <span className="selection-arrow">▼</span>
                </>
              )
              : (
                <>
                  <ShareLabel
                    address={selectedShare.value}
                    viewingAuthorSecret={currentAuthor.value?.secret}
                  />
                  <span className="selection-arrow">▼</span>
                </>
              )}
          </div>
        </Listbox.Button>
        <div className="options-root">
          <Listbox.Options className="listbox-options">
            {shares.value.map((share) => {
              return (
                <Listbox.Option
                  key={share}
                  value={share}
                  className="option-root"
                >
                  {(
                    { active, selected }: {
                      active: boolean;
                      selected: boolean;
                    },
                  ) => (
                    <div
                      className={`listbox-option ${
                        active ? "listbox-option-active" : ""
                      } ${selected ? "listbox-option-selected" : ""}`}
                    >
                      <ShareLabel
                        address={share}
                        viewingAuthorSecret={currentAuthor.value?.secret}
                      />
                      <div className={"checkmark"}>{selected && "✓"}</div>
                    </div>
                  )}
                </Listbox.Option>
              );
            })}
          </Listbox.Options>
        </div>
      </Listbox>
    </div>
  );
}

const el = document.getElementById("root");

if (el) {
  render(<BookshelfApplet />, el);
}

export function useEpubDownload(index: BookIndex) {
  return useCallback(async (bookItem: BookItem) => {
    const bytes = await index.getBookBytes(
      bookItem.uploader,
      bookItem.sha256hash,
    );

    if (!bytes) {
      return;
    }

    const blob = new Blob([bytes], {
      type: "application/epub+zip",
    });
    const url = window.URL.createObjectURL(blob);

    const a = document.createElement("a");
    document.body.appendChild(a);
    a.setAttribute("style", "display: none");
    a.href = url;
    a.download = `${bookItem.title}.epub`;
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
  }, []);
}
