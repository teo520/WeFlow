import { app } from 'electron'
import { join, dirname, basename } from 'path'
import { existsSync, readdirSync, readFileSync, statSync, copyFileSync, mkdirSync } from 'fs'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { Worker } from 'worker_threads'
import os from 'os'

const execFileAsync = promisify(execFile)

type DbKeyResult = { success: boolean; key?: string; error?: string; logs?: string[] }
type ImageKeyResult = { success: boolean; xorKey?: number; aesKey?: string; error?: string }

export class KeyService {
  private koffi: any = null
  private lib: any = null
  private initialized = false
  private initHook: any = null
  private pollKeyData: any = null
  private getStatusMessage: any = null
  private cleanupHook: any = null
  private getLastErrorMsg: any = null

  // Win32 APIs
  private kernel32: any = null
  private user32: any = null
  private advapi32: any = null

  // Kernel32 (已移除内存扫描相关的 API)
  private OpenProcess: any = null
  private CloseHandle: any = null
  private TerminateProcess: any = null
  private QueryFullProcessImageNameW: any = null

  // User32
  private EnumWindows: any = null
  private GetWindowTextW: any = null
  private GetWindowTextLengthW: any = null
  private GetClassNameW: any = null
  private GetWindowThreadProcessId: any = null
  private IsWindowVisible: any = null
  private EnumChildWindows: any = null
  private PostMessageW: any = null
  private WNDENUMPROC_PTR: any = null

  // Advapi32
  private RegOpenKeyExW: any = null
  private RegQueryValueExW: any = null
  private RegCloseKey: any = null

  // Constants
  private readonly PROCESS_ALL_ACCESS = 0x1F0FFF
  private readonly PROCESS_TERMINATE = 0x0001
  private readonly KEY_READ = 0x20019
  private readonly HKEY_LOCAL_MACHINE = 0x80000002
  private readonly HKEY_CURRENT_USER = 0x80000001
  private readonly ERROR_SUCCESS = 0
  private readonly WM_CLOSE = 0x0010

  private getDllPath(): string {
    const isPackaged = typeof app !== 'undefined' && app ? app.isPackaged : process.env.NODE_ENV === 'production'
    const candidates: string[] = []

    if (process.env.WX_KEY_DLL_PATH) {
      candidates.push(process.env.WX_KEY_DLL_PATH)
    }

    if (isPackaged) {
      candidates.push(join(process.resourcesPath, 'resources', 'wx_key.dll'))
      candidates.push(join(process.resourcesPath, 'wx_key.dll'))
    } else {
      const cwd = process.cwd()
      candidates.push(join(cwd, 'resources', 'wx_key.dll'))
      candidates.push(join(app.getAppPath(), 'resources', 'wx_key.dll'))
    }

    for (const path of candidates) {
      if (existsSync(path)) return path
    }

    return candidates[0]
  }

  private isNetworkPath(path: string): boolean {
    if (path.startsWith('\\\\')) return true
    return false
  }

  private localizeNetworkDll(originalPath: string): string {
    try {
      const tempDir = join(os.tmpdir(), 'weflow_dll_cache')
      if (!existsSync(tempDir)) {
        mkdirSync(tempDir, { recursive: true })
      }
      const localPath = join(tempDir, 'wx_key.dll')
      if (existsSync(localPath)) return localPath

      copyFileSync(originalPath, localPath)
      return localPath
    } catch (e) {
      console.error('DLL 本地化失败:', e)
      return originalPath
    }
  }

  private ensureLoaded(): boolean {
    if (this.initialized) return true

    let dllPath = ''
    try {
      this.koffi = require('koffi')
      dllPath = this.getDllPath()

      if (!existsSync(dllPath)) {
        console.error(`wx_key.dll 不存在于路径: ${dllPath}`)
        return false
      }

      if (this.isNetworkPath(dllPath)) {
        dllPath = this.localizeNetworkDll(dllPath)
      }

      this.lib = this.koffi.load(dllPath)
      this.initHook = this.lib.func('bool InitializeHook(uint32 targetPid)')
      this.pollKeyData = this.lib.func('bool PollKeyData(_Out_ char *keyBuffer, int bufferSize)')
      this.getStatusMessage = this.lib.func('bool GetStatusMessage(_Out_ char *msgBuffer, int bufferSize, _Out_ int *outLevel)')
      this.cleanupHook = this.lib.func('bool CleanupHook()')
      this.getLastErrorMsg = this.lib.func('const char* GetLastErrorMsg()')

      this.initialized = true
      return true
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e)
      console.error(`加载 wx_key.dll 失败\n  路径: ${dllPath}\n  错误: ${errorMsg}`)
      return false
    }
  }

  private ensureWin32(): boolean {
    return process.platform === 'win32'
  }

  private ensureKernel32(): boolean {
    if (this.kernel32) return true
    try {
      this.koffi = require('koffi')
      this.kernel32 = this.koffi.load('kernel32.dll')

      // 直接使用原生支持的 'void*' 替换 'HANDLE'，绝对不会再报类型错误
      this.OpenProcess = this.kernel32.func('OpenProcess', 'void*', ['uint32', 'bool', 'uint32'])
      this.CloseHandle = this.kernel32.func('CloseHandle', 'bool', ['void*'])
      this.TerminateProcess = this.kernel32.func('TerminateProcess', 'bool', ['void*', 'uint32'])
      this.QueryFullProcessImageNameW = this.kernel32.func('QueryFullProcessImageNameW', 'bool', ['void*', 'uint32', this.koffi.out('uint16*'), this.koffi.out('uint32*')])

      return true
    } catch (e) {
      console.error('初始化 kernel32 失败:', e)
      return false
    }
  }

  private decodeUtf8(buf: Buffer): string {
    const nullIdx = buf.indexOf(0)
    return buf.toString('utf8', 0, nullIdx > -1 ? nullIdx : undefined).trim()
  }

  private ensureUser32(): boolean {
    if (this.user32) return true
    try {
      this.koffi = require('koffi')
      this.user32 = this.koffi.load('user32.dll')

      const WNDENUMPROC = this.koffi.proto('bool __stdcall (void *hWnd, intptr_t lParam)')
      this.WNDENUMPROC_PTR = this.koffi.pointer(WNDENUMPROC)

      this.EnumWindows = this.user32.func('EnumWindows', 'bool', [this.WNDENUMPROC_PTR, 'intptr_t'])
      this.EnumChildWindows = this.user32.func('EnumChildWindows', 'bool', ['void*', this.WNDENUMPROC_PTR, 'intptr_t'])
      this.PostMessageW = this.user32.func('PostMessageW', 'bool', ['void*', 'uint32', 'uintptr_t', 'intptr_t'])
      this.GetWindowTextW = this.user32.func('GetWindowTextW', 'int', ['void*', this.koffi.out('uint16*'), 'int'])
      this.GetWindowTextLengthW = this.user32.func('GetWindowTextLengthW', 'int', ['void*'])
      this.GetClassNameW = this.user32.func('GetClassNameW', 'int', ['void*', this.koffi.out('uint16*'), 'int'])
      this.GetWindowThreadProcessId = this.user32.func('GetWindowThreadProcessId', 'uint32', ['void*', this.koffi.out('uint32*')])
      this.IsWindowVisible = this.user32.func('IsWindowVisible', 'bool', ['void*'])

      return true
    } catch (e) {
      console.error('初始化 user32 失败:', e)
      return false
    }
  }

  private ensureAdvapi32(): boolean {
    if (this.advapi32) return true
    try {
      this.koffi = require('koffi')
      this.advapi32 = this.koffi.load('advapi32.dll')

      const HKEY = this.koffi.alias('HKEY', 'intptr_t')
      const HKEY_PTR = this.koffi.pointer(HKEY)

      this.RegOpenKeyExW = this.advapi32.func('RegOpenKeyExW', 'long', [HKEY, 'uint16*', 'uint32', 'uint32', this.koffi.out(HKEY_PTR)])
      this.RegQueryValueExW = this.advapi32.func('RegQueryValueExW', 'long', [HKEY, 'uint16*', 'uint32*', this.koffi.out('uint32*'), this.koffi.out('uint8*'), this.koffi.out('uint32*')])
      this.RegCloseKey = this.advapi32.func('RegCloseKey', 'long', [HKEY])

      return true
    } catch (e) {
      console.error('初始化 advapi32 失败:', e)
      return false
    }
  }

  private decodeCString(ptr: any): string {
    try {
      if (typeof ptr === 'string') return ptr
      return this.koffi.decode(ptr, 'char', -1)
    } catch {
      return ''
    }
  }

  // --- WeChat Process & Path Finding ---

  private readRegistryString(rootKey: number, subKey: string, valueName: string): string | null {
    if (!this.ensureAdvapi32()) return null
    const subKeyBuf = Buffer.from(subKey + '\0', 'ucs2')
    const valueNameBuf = valueName ? Buffer.from(valueName + '\0', 'ucs2') : null
    const phkResult = Buffer.alloc(8)

    if (this.RegOpenKeyExW(rootKey, subKeyBuf, 0, this.KEY_READ, phkResult) !== this.ERROR_SUCCESS) return null

    const hKey = this.koffi.decode(phkResult, 'uintptr_t')

    try {
      const lpcbData = Buffer.alloc(4)
      lpcbData.writeUInt32LE(0, 0)

      let ret = this.RegQueryValueExW(hKey, valueNameBuf, null, null, null, lpcbData)
      if (ret !== this.ERROR_SUCCESS) return null

      const size = lpcbData.readUInt32LE(0)
      if (size === 0) return null

      const dataBuf = Buffer.alloc(size)
      ret = this.RegQueryValueExW(hKey, valueNameBuf, null, null, dataBuf, lpcbData)
      if (ret !== this.ERROR_SUCCESS) return null

      let str = dataBuf.toString('ucs2')
      if (str.endsWith('\0')) str = str.slice(0, -1)
      return str
    } finally {
      this.RegCloseKey(hKey)
    }
  }

  private async getProcessExecutablePath(pid: number): Promise<string | null> {
    if (!this.ensureKernel32()) return null
    const hProcess = this.OpenProcess(0x1000, false, pid)
    if (!hProcess) return null

    try {
      const sizeBuf = Buffer.alloc(4)
      sizeBuf.writeUInt32LE(1024, 0)
      const pathBuf = Buffer.alloc(1024 * 2)

      const ret = this.QueryFullProcessImageNameW(hProcess, 0, pathBuf, sizeBuf)
      if (ret) {
        const len = sizeBuf.readUInt32LE(0)
        return pathBuf.toString('ucs2', 0, len * 2)
      }
      return null
    } catch (e) {
      console.error('获取进程路径失败:', e)
      return null
    } finally {
      this.CloseHandle(hProcess)
    }
  }

  private async findWeChatInstallPath(): Promise<string | null> {
    try {
      const pid = await this.findWeChatPid()
      if (pid) {
        const runPath = await this.getProcessExecutablePath(pid)
        if (runPath && existsSync(runPath)) return runPath
      }
    } catch (e) {
      console.error('尝试获取运行中微信路径失败:', e)
    }

    const uninstallKeys = [
      'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
    ]
    const roots = [this.HKEY_LOCAL_MACHINE, this.HKEY_CURRENT_USER]
    const tencentKeys = [
      'Software\\Tencent\\WeChat',
      'Software\\WOW6432Node\\Tencent\\WeChat',
      'Software\\Tencent\\Weixin',
    ]

    for (const root of roots) {
      for (const key of tencentKeys) {
        const path = this.readRegistryString(root, key, 'InstallPath')
        if (path && existsSync(join(path, 'Weixin.exe'))) return join(path, 'Weixin.exe')
        if (path && existsSync(join(path, 'WeChat.exe'))) return join(path, 'WeChat.exe')
      }
    }

    for (const root of roots) {
      for (const parent of uninstallKeys) {
        const path = this.readRegistryString(root, parent + '\\WeChat', 'InstallLocation')
        if (path && existsSync(join(path, 'Weixin.exe'))) return join(path, 'Weixin.exe')
      }
    }

    const drives = ['C', 'D', 'E', 'F']
    const commonPaths = [
      'Program Files\\Tencent\\WeChat\\WeChat.exe',
      'Program Files (x86)\\Tencent\\WeChat\\WeChat.exe',
      'Program Files\\Tencent\\Weixin\\Weixin.exe',
      'Program Files (x86)\\Tencent\\Weixin\\Weixin.exe'
    ]

    for (const drive of drives) {
      for (const p of commonPaths) {
        const full = join(drive + ':\\', p)
        if (existsSync(full)) return full
      }
    }

    return null
  }

  private async findPidByImageName(imageName: string): Promise<number | null> {
    try {
      const { stdout } = await execFileAsync('tasklist', ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH'])
      const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      for (const line of lines) {
        if (line.startsWith('INFO:')) continue
        const parts = line.split('","').map((p) => p.replace(/^"|"$/g, ''))
        if (parts[0]?.toLowerCase() === imageName.toLowerCase()) {
          const pid = Number(parts[1])
          if (!Number.isNaN(pid)) return pid
        }
      }
      return null
    } catch (e) {
      return null
    }
  }

  private async findWeChatPid(): Promise<number | null> {
    const names = ['Weixin.exe', 'WeChat.exe']
    for (const name of names) {
      const pid = await this.findPidByImageName(name)
      if (pid) return pid
    }
    const fallbackPid = await this.waitForWeChatWindow(5000)
    return fallbackPid ?? null
  }

  private async waitForWeChatExit(timeoutMs = 8000): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const weixinPid = await this.findPidByImageName('Weixin.exe')
      const wechatPid = await this.findPidByImageName('WeChat.exe')
      if (!weixinPid && !wechatPid) return true
      await new Promise(r => setTimeout(r, 400))
    }
    return false
  }

  private async closeWeChatWindows(): Promise<boolean> {
    if (!this.ensureUser32()) return false
    let requested = false

    const enumWindowsCallback = this.koffi.register((hWnd: any, lParam: any) => {
      if (!this.IsWindowVisible(hWnd)) return true
      const title = this.getWindowTitle(hWnd)
      const className = this.getClassName(hWnd)
      const classLower = (className || '').toLowerCase()
      const isWeChatWindow = this.isWeChatWindowTitle(title) || classLower.includes('wechat') || classLower.includes('weixin')
      if (!isWeChatWindow) return true

      requested = true
      try {
        this.PostMessageW?.(hWnd, this.WM_CLOSE, 0, 0)
      } catch { }
      return true
    }, this.WNDENUMPROC_PTR)

    this.EnumWindows(enumWindowsCallback, 0)
    this.koffi.unregister(enumWindowsCallback)

    return requested
  }

  private async killWeChatProcesses(): Promise<boolean> {
    const requested = await this.closeWeChatWindows()
    if (requested) {
      const gracefulOk = await this.waitForWeChatExit(1500)
      if (gracefulOk) return true
    }

    try {
      await execFileAsync('taskkill', ['/F', '/T', '/IM', 'Weixin.exe'])
      await execFileAsync('taskkill', ['/F', '/T', '/IM', 'WeChat.exe'])
    } catch (e) { }

    return await this.waitForWeChatExit(5000)
  }

  // --- Window Detection ---

  private getWindowTitle(hWnd: any): string {
    const len = this.GetWindowTextLengthW(hWnd)
    if (len === 0) return ''
    const buf = Buffer.alloc((len + 1) * 2)
    this.GetWindowTextW(hWnd, buf, len + 1)
    return buf.toString('ucs2', 0, len * 2)
  }

  private getClassName(hWnd: any): string {
    const buf = Buffer.alloc(512)
    const len = this.GetClassNameW(hWnd, buf, 256)
    return buf.toString('ucs2', 0, len * 2)
  }

  private isWeChatWindowTitle(title: string): boolean {
    const normalized = title.trim()
    if (!normalized) return false
    const lower = normalized.toLowerCase()
    return normalized === '微信' || lower === 'wechat' || lower === 'weixin'
  }

  private async waitForWeChatWindow(timeoutMs = 25000): Promise<number | null> {
    if (!this.ensureUser32()) return null
    const startTime = Date.now()
    while (Date.now() - startTime < timeoutMs) {
      let foundPid: number | null = null

      const enumWindowsCallback = this.koffi.register((hWnd: any, lParam: any) => {
        if (!this.IsWindowVisible(hWnd)) return true
        const title = this.getWindowTitle(hWnd)
        if (!this.isWeChatWindowTitle(title)) return true

        const pidBuf = Buffer.alloc(4)
        this.GetWindowThreadProcessId(hWnd, pidBuf)
        const pid = pidBuf.readUInt32LE(0)
        if (pid) {
          foundPid = pid
          return false
        }
        return true
      }, this.WNDENUMPROC_PTR)

      this.EnumWindows(enumWindowsCallback, 0)
      this.koffi.unregister(enumWindowsCallback)

      if (foundPid) return foundPid
      await new Promise(r => setTimeout(r, 500))
    }
    return null
  }

  private collectChildWindowInfos(parent: any): Array<{ title: string; className: string }> {
    const children: Array<{ title: string; className: string }> = []
    const enumChildCallback = this.koffi.register((hChild: any, lp: any) => {
      const title = this.getWindowTitle(hChild).trim()
      const className = this.getClassName(hChild).trim()
      children.push({ title, className })
      return true
    }, this.WNDENUMPROC_PTR)
    this.EnumChildWindows(parent, enumChildCallback, 0)
    this.koffi.unregister(enumChildCallback)
    return children
  }

  private hasReadyComponents(children: Array<{ title: string; className: string }>): boolean {
    if (children.length === 0) return false

    const readyTexts = ['聊天', '登录', '账号']
    const readyClassMarkers = ['WeChat', 'Weixin', 'TXGuiFoundation', 'Qt5', 'ChatList', 'MainWnd', 'BrowserWnd', 'ListView']
    const readyChildCountThreshold = 14

    let classMatchCount = 0
    let titleMatchCount = 0
    let hasValidClassName = false

    for (const child of children) {
      const normalizedTitle = child.title.replace(/\s+/g, '')
      if (normalizedTitle) {
        if (readyTexts.some(marker => normalizedTitle.includes(marker))) return true
        titleMatchCount += 1
      }
      const className = child.className
      if (className) {
        if (readyClassMarkers.some(marker => className.includes(marker))) return true
        if (className.length > 5) {
          classMatchCount += 1
          hasValidClassName = true
        }
      }
    }

    if (classMatchCount >= 3 || titleMatchCount >= 2) return true
    if (children.length >= readyChildCountThreshold) return true
    if (hasValidClassName && children.length >= 5) return true
    return false
  }

  private async waitForWeChatWindowComponents(pid: number, timeoutMs = 15000): Promise<boolean> {
    if (!this.ensureUser32()) return true
    const startTime = Date.now()
    while (Date.now() - startTime < timeoutMs) {
      let ready = false
      const enumWindowsCallback = this.koffi.register((hWnd: any, lParam: any) => {
        if (!this.IsWindowVisible(hWnd)) return true
        const title = this.getWindowTitle(hWnd)
        if (!this.isWeChatWindowTitle(title)) return true

        const pidBuf = Buffer.alloc(4)
        this.GetWindowThreadProcessId(hWnd, pidBuf)
        const windowPid = pidBuf.readUInt32LE(0)
        if (windowPid !== pid) return true

        const children = this.collectChildWindowInfos(hWnd)
        if (this.hasReadyComponents(children)) {
          ready = true
          return false
        }
        return true
      }, this.WNDENUMPROC_PTR)

      this.EnumWindows(enumWindowsCallback, 0)
      this.koffi.unregister(enumWindowsCallback)

      if (ready) return true
      await new Promise(r => setTimeout(r, 500))
    }
    return true
  }

  // --- DB Key Logic (Unchanged core flow) ---

  async autoGetDbKey(
      timeoutMs = 60_000,
      onStatus?: (message: string, level: number) => void
  ): Promise<DbKeyResult> {
    if (!this.ensureWin32()) return { success: false, error: '仅支持 Windows' }
    if (!this.ensureLoaded()) return { success: false, error: 'wx_key.dll 未加载' }
    if (!this.ensureKernel32()) return { success: false, error: 'Kernel32 Init Failed' }

    const logs: string[] = []

    onStatus?.('正在定位微信安装路径...', 0)
    let wechatPath = await this.findWeChatInstallPath()
    if (!wechatPath) {
      const err = '未找到微信安装路径，请确认已安装PC微信'
      onStatus?.(err, 2)
      return { success: false, error: err }
    }

    onStatus?.('正在关闭微信以进行获取...', 0)
    const closed = await this.killWeChatProcesses()
    if (!closed) {
      const err = '无法自动关闭微信，请手动退出后重试'
      onStatus?.(err, 2)
      return { success: false, error: err }
    }

    onStatus?.('正在启动微信...', 0)
    const sub = spawn(wechatPath, {
      detached: true,
      stdio: 'ignore',
      cwd: dirname(wechatPath)
    })
    sub.unref()

    onStatus?.('等待微信界面就绪...', 0)
    const pid = await this.waitForWeChatWindow()
    if (!pid) return { success: false, error: '启动微信失败或等待界面就绪超时' }

    onStatus?.(`检测到微信窗口 (PID: ${pid})，正在获取...`, 0)
    onStatus?.('正在检测微信界面组件...', 0)
    await this.waitForWeChatWindowComponents(pid, 15000)

    const ok = this.initHook(pid)
    if (!ok) {
      const error = this.getLastErrorMsg ? this.decodeCString(this.getLastErrorMsg()) : ''
      if (error) {
        if (error.includes('0xC0000022') || error.includes('ACCESS_DENIED') || error.includes('打开目标进程失败')) {
          const friendlyError = '权限不足：无法访问微信进程。\n\n解决方法：\n1. 右键 WeFlow 图标，选择"以管理员身份运行"\n2. 关闭可能拦截的安全软件（如360、火绒等）\n3. 确保微信没有以管理员权限运行'
          return { success: false, error: friendlyError }
        }
        return { success: false, error }
      }
      const statusBuffer = Buffer.alloc(256)
      const levelOut = [0]
      const status = this.getStatusMessage && this.getStatusMessage(statusBuffer, statusBuffer.length, levelOut)
          ? this.decodeUtf8(statusBuffer)
          : ''
      return { success: false, error: status || '初始化失败' }
    }

    const keyBuffer = Buffer.alloc(128)
    const start = Date.now()

    try {
      while (Date.now() - start < timeoutMs) {
        if (this.pollKeyData(keyBuffer, keyBuffer.length)) {
          const key = this.decodeUtf8(keyBuffer)
          if (key.length === 64) {
            onStatus?.('密钥获取成功', 1)
            return { success: true, key, logs }
          }
        }

        for (let i = 0; i < 5; i++) {
          const statusBuffer = Buffer.alloc(256)
          const levelOut = [0]
          if (!this.getStatusMessage(statusBuffer, statusBuffer.length, levelOut)) break
          const msg = this.decodeUtf8(statusBuffer)
          const level = levelOut[0] ?? 0
          if (msg) {
            logs.push(msg)
            onStatus?.(msg, level)
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 120))
      }
    } finally {
      try {
        this.cleanupHook()
      } catch { }
    }

    return { success: false, error: '获取密钥超时', logs }
  }

  // --- Image Key Stuff (Refactored to Multi-core Crypto Brute Force) ---

  private isAccountDir(dirPath: string): boolean {
    return (
        existsSync(join(dirPath, 'db_storage')) ||
        existsSync(join(dirPath, 'FileStorage', 'Image')) ||
        existsSync(join(dirPath, 'FileStorage', 'Image2'))
    )
  }

  private isPotentialAccountName(name: string): boolean {
    const lower = name.toLowerCase()
    if (lower.startsWith('all') || lower.startsWith('applet') || lower.startsWith('backup') || lower.startsWith('wmpf')) return false
    if (lower.startsWith('wxid_')) return true
    if (/^\d+$/.test(name) && name.length >= 6) return true
    return name.length > 5
  }

  private listAccountDirs(rootDir: string): string[] {
    try {
      const entries = readdirSync(rootDir)
      const high: string[] = []
      const low: string[] = []
      for (const entry of entries) {
        const fullPath = join(rootDir, entry)
        try {
          if (!statSync(fullPath).isDirectory()) continue
        } catch { continue }

        if (!this.isPotentialAccountName(entry)) continue

        if (this.isAccountDir(fullPath)) high.push(fullPath)
        else low.push(fullPath)
      }
      return high.length ? high.sort() : low.sort()
    } catch {
      return []
    }
  }

  private normalizeExistingDir(inputPath: string): string | null {
    const trimmed = inputPath.replace(/[\\\\/]+$/, '')
    if (!existsSync(trimmed)) return null
    try {
      const stats = statSync(trimmed)
      if (stats.isFile()) return dirname(trimmed)
    } catch {
      return null
    }
    return trimmed
  }

  private resolveAccountDirFromPath(inputPath: string): string | null {
    const normalized = this.normalizeExistingDir(inputPath)
    if (!normalized) return null

    if (this.isAccountDir(normalized)) return normalized

    const lower = normalized.toLowerCase()
    if (lower.endsWith('db_storage') || lower.endsWith('filestorage') || lower.endsWith('image') || lower.endsWith('image2')) {
      const parent = dirname(normalized)
      if (this.isAccountDir(parent)) return parent
      const grandParent = dirname(parent)
      if (this.isAccountDir(grandParent)) return grandParent
    }

    const candidates = this.listAccountDirs(normalized)
    if (candidates.length) return candidates[0]
    return null
  }

  private resolveAccountDir(manualDir?: string): string | null {
    if (manualDir) {
      const resolved = this.resolveAccountDirFromPath(manualDir)
      if (resolved) return resolved
    }

    const userProfile = process.env.USERPROFILE
    if (!userProfile) return null
    const roots = [
      join(userProfile, 'Documents', 'xwechat_files'),
      join(userProfile, 'Documents', 'WeChat Files')
    ]
    for (const root of roots) {
      if (!existsSync(root)) continue
      const candidates = this.listAccountDirs(root)
      if (candidates.length) return candidates[0]
    }
    return null
  }

  private findTemplateDatFiles(rootDir: string): string[] {
    const files: string[] = []
    const stack = [rootDir]
    const maxFiles = 256
    while (stack.length && files.length < maxFiles) {
      const dir = stack.pop() as string
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch { continue }
      for (const entry of entries) {
        const fullPath = join(dir, entry)
        let stats: any
        try {
          stats = statSync(fullPath)
        } catch { continue }
        if (stats.isDirectory()) {
          stack.push(fullPath)
        } else if (entry.endsWith('_t.dat')) {
          files.push(fullPath)
          if (files.length >= maxFiles) break
        }
      }
    }

    if (!files.length) return []
    const dateReg = /(\d{4}-\d{2})/
    files.sort((a, b) => {
      const ma = a.match(dateReg)?.[1]
      const mb = b.match(dateReg)?.[1]
      if (ma && mb) return mb.localeCompare(ma)
      return 0
    })
    return files.slice(0, 128)
  }

  private getXorKey(templateFiles: string[]): number | null {
    const counts = new Map<number, number>()
    const tailSignatures = [
      Buffer.from([0xFF, 0xD9]),
      Buffer.from([0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82])
    ]
    for (const file of templateFiles) {
      try {
        const bytes = readFileSync(file)
        for (const signature of tailSignatures) {
          if (bytes.length < signature.length) continue
          const tail = bytes.subarray(bytes.length - signature.length)
          const xorKey = tail[0] ^ signature[0]
          let valid = true
          for (let i = 1; i < signature.length; i++) {
            if ((tail[i] ^ xorKey) !== signature[i]) {
              valid = false
              break
            }
          }
          if (valid) counts.set(xorKey, (counts.get(xorKey) ?? 0) + 1)
        }
      } catch { }
    }
    if (!counts.size) return null
    let bestKey: number | null = null
    let bestCount = 0
    for (const [key, count] of counts) {
      if (count > bestCount) {
        bestCount = count
        bestKey = key
      }
    }
    return bestKey
  }

  // 改为返回 Buffer 数组，收集最多2个样本用于双重校验
  private getCiphertextsFromTemplate(templateFiles: string[]): Buffer[] {
    const ciphertexts: Buffer[] = []
    for (const file of templateFiles) {
      try {
        const bytes = readFileSync(file)
        if (bytes.length < 0x1f) continue
        // 匹配微信 DAT 文件的特定头部特征
        if (
            bytes[0] === 0x07 && bytes[1] === 0x08 && bytes[2] === 0x56 &&
            bytes[3] === 0x32 && bytes[4] === 0x08 && bytes[5] === 0x07
        ) {
          ciphertexts.push(bytes.subarray(0x0f, 0x1f))
          // 收集到 2 个样本就足够做双重校验了
          if (ciphertexts.length >= 2) break
        }
      } catch { }
    }
    return ciphertexts
  }

  private async bruteForceAesKey(
      xorKey: number,
      wxid: string,
      ciphertexts: Buffer[],
      onProgress?: (msg: string) => void
  ): Promise<string | null> {
    const numCores = os.cpus().length || 4
    const totalCombinations = 1 << 24 // 16,777,216 种可能性
    const chunkSize = Math.ceil(totalCombinations / numCores)

    onProgress?.(`准备启动 ${numCores} 个线程进行极速爆破...`)

    const workerCode = `
      const { parentPort, workerData } = require('worker_threads');
      const crypto = require('crypto');

      const { start, end, xorKey, wxid, cipherHexList } = workerData;
      const ciphertexts = cipherHexList.map(hex => Buffer.from(hex, 'hex'));

      function verifyKey(cipher, keyStr) {
        try {
          const decipher = crypto.createDecipheriv('aes-128-ecb', keyStr, null);
          decipher.setAutoPadding(false);
          const decrypted = Buffer.concat([decipher.update(cipher), decipher.final()]);
          const isJpeg = decrypted.length >= 3 && decrypted[0] === 0xff && decrypted[1] === 0xd8 && decrypted[2] === 0xff;
          const isPng = decrypted.length >= 8 && decrypted[0] === 0x89 && decrypted[1] === 0x50 && decrypted[2] === 0x4e && decrypted[3] === 0x47;
          return isJpeg || isPng;
        } catch {
          return false;
        }
      }

      let found = null;
      for (let upper = end - 1; upper >= start; upper--) {
        // 我就写 -- 
        if (upper % 100000 === 0 && upper !== start) {
          parentPort.postMessage({ type: 'progress', scanned: 100000 });
        }

        const number = (upper * 256) + xorKey; 

        // 1. 无符号整数校验
        const strUnsigned = number.toString(10) + wxid;
        const md5Unsigned = crypto.createHash('md5').update(strUnsigned).digest('hex').slice(0, 16);
        
        let isValidUnsigned = true;
        for (const cipher of ciphertexts) {
          if (!verifyKey(cipher, md5Unsigned)) {
            isValidUnsigned = false;
            break;
          }
        }
        if (isValidUnsigned) {
          found = md5Unsigned;
          break;
        }

        // 2. 带符号整数校验 (溢出边界情况)
        if (number > 0x7FFFFFFF) {
           const strSigned = (number | 0).toString(10) + wxid;
           const md5Signed = crypto.createHash('md5').update(strSigned).digest('hex').slice(0, 16);
           
           let isValidSigned = true;
           for (const cipher of ciphertexts) {
             if (!verifyKey(cipher, md5Signed)) {
               isValidSigned = false;
               break;
             }
           }
           if (isValidSigned) {
             found = md5Signed;
             break;
           }
        }
      }

      if (found) {
        parentPort.postMessage({ type: 'success', key: found });
      } else {
        parentPort.postMessage({ type: 'done' });
      }
    `

    return new Promise((resolve) => {
      let activeWorkers = numCores
      let resolved = false
      let totalScanned = 0 // 总进度计数器
      const workers: Worker[] = []

      const cleanup = () => {
        for (const w of workers) w.terminate()
      }

      for (let i = 0; i < numCores; i++) {
        const start = i * chunkSize
        const end = Math.min(start + chunkSize, totalCombinations)

        const worker = new Worker(workerCode, {
          eval: true,
          workerData: {
            start,
            end,
            xorKey,
            wxid,
            cipherHexList: ciphertexts.map(c => c.toString('hex')) // 传入数组
          }
        })
        workers.push(worker)

        worker.on('message', (msg) => {
          if (!msg) return
          if (msg.type === 'progress') {
            totalScanned += msg.scanned
            const percent = ((totalScanned / totalCombinations) * 100).toFixed(1)
            // 优化文案，并确保包含 (xx.x%) 供前端解析
            onProgress?.(`多核爆破引擎运行中：已扫描 ${(totalScanned / 10000).toFixed(0)} 万个密钥空间 (${percent}%)`)
          } else if (msg.type === 'success' && !resolved) {
            resolved = true
            cleanup()
            resolve(msg.key)
          } else if (msg.type === 'done') {
            // 单个 worker 跑完了没有找到（计数统一在 exit 事件处理）
          }
        })

        worker.on('error', (err) => {
          console.error('Worker error:', err)
        })

        // 统一在 exit 事件中做完成计数，避免 done/error + exit 双重递减
        worker.on('exit', () => {
          activeWorkers--
          if (activeWorkers === 0 && !resolved) resolve(null)
        })
      }
    })
  }

  async autoGetImageKey(
      manualDir?: string,
      onProgress?: (message: string) => void
  ): Promise<ImageKeyResult> {
    onProgress?.('正在定位微信账号数据目录...')
    const accountDir = this.resolveAccountDir(manualDir)
    if (!accountDir) return { success: false, error: '未找到微信账号目录' }

    let wxid = basename(accountDir)
    wxid = wxid.replace(/_[0-9a-fA-F]{4}$/, '')

    onProgress?.('正在收集并分析加密模板文件...')
    const templateFiles = this.findTemplateDatFiles(accountDir)
    if (!templateFiles.length) return { success: false, error: '未找到模板文件' }

    onProgress?.('正在计算特征 XOR 密钥...')
    const xorKey = this.getXorKey(templateFiles)
    if (xorKey == null) return { success: false, error: '无法计算 XOR 密钥' }

    onProgress?.('正在读取加密模板区块...')
    const ciphertexts = this.getCiphertextsFromTemplate(templateFiles)
    if (ciphertexts.length < 2) return { success: false, error: '可用的加密样本不足（至少需要2个），请确认账号目录下有足够的模板图片' }

    onProgress?.(`成功提取 ${ciphertexts.length} 个特征样本，准备交叉校验...`)
    onProgress?.(`准备启动 ${os.cpus().length || 4} 线程并发爆破引擎 (基于 wxid: ${wxid})...`)

    const aesKey = await this.bruteForceAesKey(xorKey, wxid, ciphertexts, (msg) => {
      onProgress?.(msg)
    })

    if (!aesKey) {
      return {
        success: false,
        error: 'AES 密钥爆破失败，请确认该账号近期是否有接收过图片，或更换账号目录重试'
      }
    }

    return { success: true, xorKey, aesKey }
  }
}