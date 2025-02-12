export function readString(wasm, ptr, len) {
  const buf = new Uint8Array(wasm.memory.buffer, ptr, len);
  return (new TextDecoder("utf-8")).decode(buf)
}

export function withWriteable(wasm, callback) {
  const writeable = wasm.diplomat_buffer_writeable_create(0);
  try {
    callback(writeable);
    const outStringPtr = wasm.diplomat_buffer_writeable_get_bytes(writeable);
    const outStringLen = wasm.diplomat_buffer_writeable_len(writeable);
    return readString(wasm, outStringPtr, outStringLen);
  } finally {
    wasm.diplomat_buffer_writeable_destroy(writeable);
  }
}

export class FFIError extends Error {
  constructor(error_value) {
    super("Error over FFI");
    this.error_value = error_value; // (2)
  }
}

export function extractCodePoint(str, param) {
  const cp = str.codePointAt?.(0);
  if ((!cp && cp !== 0) || [...str]?.length != 1) {
    throw new TypeError(`Expected single-character string for char parameter ${param}, found ${str}`);
  }
  return cp;
}

// Get the pointer returned by an FFI function
//
// It's tempting to call `(new Uint32Array(wasm.memory.buffer, FFI_func(), 1))[0]`.
// However, there's a chance that `wasm.memory.buffer` will be resized between
// the time it's accessed and the time it's used, invalidating the view.
// This function ensures that the view into wasm memory is fresh.
//
// This is used for methods that return multiple types into a wasm buffer, where
// one of those types is another ptr. Call this method to get access to the returned
// ptr, so the return buffer can be freed.
export function ptrRead(wasm, ptr) {
  return (new Uint32Array(wasm.memory.buffer, ptr, 1))[0];
}

// Get the flag of a result type.
export function resultFlag(wasm, ptr, offset) {
  return (new Uint8Array(wasm.memory.buffer, ptr + offset, 1))[0];
}

// Get the discriminant of a Rust enum.
export function enumDiscriminant(wasm, ptr) {
  return (new Int32Array(wasm.memory.buffer, ptr, 1))[0]
}

// A wrapper around a slice of WASM memory that can be freed manually or
// automatically by the garbage collector.
//
// This type is necessary for Rust functions that take a `&str` or `&[T]`, since
// they can create an edge to this object if they borrow from the str/slice,
// or we can manually free the WASM memory if they don't.
export class DiplomatBuf {
  static str = (wasm, string) => {
    const bytes = (new TextEncoder()).encode(string);
    return new DiplomatBuf(wasm, bytes.length, 1, buf => buf.set(bytes, 0));
  }

  static slice = (wasm, slice, align) => {
    const bytes = new Uint8Array(slice);
    return new DiplomatBuf(wasm, bytes.length, align, buf => buf.set(bytes, 0));
  }

  constructor(wasm, size, align, encodeCallback) {
    const ptr = wasm.diplomat_alloc(size, align);
    // Do the writing with a callback here as a setup for when we
    // resolve #174, which addresses removing the intermediate `Uint8Array`.
    encodeCallback(new Uint8Array(wasm.memory.buffer, ptr, size));

    this.ptr = ptr;
    this.size = size;
    this.free = () => {
      const successfully_unregistered = DiplomatBuf_finalizer.unregister(this);
      if (successfully_unregistered) {
        wasm.diplomat_free(this.ptr, this.size, align);
      } else {
        console.error(`Failed to unregister DiplomatBuf at ${ptr}, this is a bug. Either it was never registered (leak), it was already unregistered (failed attempt to double free), or the unregister token was unrecognized (fallback to GC).`);
      }
    }

    DiplomatBuf_finalizer.register(this, { wasm, ptr, size, align }, this);
  }
}

const DiplomatBuf_finalizer = new FinalizationRegistry(({ wasm, ptr, size, align }) => {
  wasm.diplomat_free(ptr, size, align);
});
