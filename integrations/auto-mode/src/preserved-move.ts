import { basename, dirname, resolve } from 'node:path'
import koffi from 'koffi'

function ancestors(path: string): string[] {
  const paths: string[] = []
  let current = dirname(resolve(path))
  while (true) {
    paths.unshift(current)
    const parent = dirname(current)
    if (current === parent) return paths
    current = parent
  }
}

/** Move an approved regular file without replacement; Windows pins its source and ancestors through kernel handles. */
export function preservedMove<T>(source: string, destination: string, validate: () => void, committed: () => T): T {
  if (process.platform !== 'win32') {
    throw Error('Protected trash requires the Windows handle-bound executor on this release')
  }
  if (process.arch !== 'x64' && process.arch !== 'arm64') throw Error('Handle-bound trash requires 64-bit Windows')
  const kernel = koffi.load('kernel32.dll')
  const open = kernel.func('void * __stdcall CreateFileW(str16 path, uint32 access, uint32 share, void * security, uint32 disposition, uint32 flags, void * template)')
  const close = kernel.func('int __stdcall CloseHandle(void * handle)')
  const info = kernel.func('int __stdcall GetFileInformationByHandle(void * handle, void * info)')
  const native = koffi.load('ntdll.dll')
  const move = native.func('int32 __stdcall NtSetInformationFile(void * handle, void * status, void * info, uint32 size, int kind)')
  const lastError = kernel.func('uint32 __stdcall GetLastError()')
  const handles: object[] = []
  const acquire = (path: string, directory: boolean, destinationParent = false): object => {
    // The destination must share writes for the kernel rename, but never delete.
    // Its handle is the rename root; a newly attached reparse point cannot redirect it.
    const handle = open(path, directory ? (destinationParent ? 0x83 : 0x81) : 0x80010000, destinationParent ? 3 : 1, null, 3, 0x00200000 | (directory ? 0x02000000 : 0), null) as object | null
    if (!handle || koffi.address(handle) === 0xffffffffffffffffn) throw Error(`Windows file protection unavailable (${lastError()})`)
    handles.push(handle)
    const bytes = Buffer.alloc(52)
    if (!info(handle, bytes)) throw Error(`Windows file identity unavailable (${lastError()})`)
    const attributes = bytes.readUInt32LE(0)
    if ((attributes & 0x400) !== 0 || Boolean(attributes & 0x10) !== directory || (!directory && bytes.readUInt32LE(40) !== 1)) throw Error('Linked or unexpected Windows file identity')
    return handle
  }
  try {
    let destinationDirectory: object | undefined
    for (const path of [...new Set([...ancestors(source), ...ancestors(destination)])]) {
      const targetParent = path === dirname(resolve(destination))
      const handle = acquire(path, true, targetParent)
      if (targetParent) destinationDirectory = handle
    }
    if (!destinationDirectory) throw Error('Missing locked recovery directory')
    const handle = acquire(source, false)
    validate()
    const name = Buffer.from(basename(destination), 'utf16le')
    // FILE_RENAME_INFO on 64-bit Windows: BOOLEAN at 0, HANDLE at 8,
    // FileNameLength at 16 and the UTF-16 name at 20. ReplaceIfExists stays false.
    const request = Buffer.alloc(20 + name.length + 2)
    request.writeBigUInt64LE(koffi.address(destinationDirectory), 8)
    request.writeUInt32LE(name.length, 16)
    name.copy(request, 20)
    const status = move(handle, Buffer.alloc(16), request, request.length, 10) as number
    if (status < 0) throw Error(`Windows protected move failed (NTSTATUS ${(status >>> 0).toString(16)})`)
    return committed()
  } finally {
    for (const handle of handles.reverse()) close(handle)
  }
}
