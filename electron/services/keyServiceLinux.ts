import { app } from 'electron'
import { join } from 'path'
import { existsSync, readdirSync, statSync, readFileSync } from 'fs'
import { execFile, exec } from 'child_process'
import { promisify } from 'util'
import sudo from 'sudo-prompt'

const execFileAsync = promisify(execFile)
const execAsync = promisify(exec)

type DbKeyResult = { success: boolean; key?: string; error?: string; logs?: string[] }
type ImageKeyResult = { success: boolean; xorKey?: number; aesKey?: string; error?: string }

export class KeyServiceLinux {

  private getHelperPath(): string {
    const isPackaged = app.isPackaged
    const candidates: string[] = []
    if (process.env.WX_KEY_HELPER_PATH) candidates.push(process.env.WX_KEY_HELPER_PATH)
    if (isPackaged) {
      candidates.push(join(process.resourcesPath, 'resources', 'xkey_helper_linux'))
      candidates.push(join(process.resourcesPath, 'xkey_helper_linux'))
    } else {
      candidates.push(join(app.getAppPath(), 'resources', 'xkey_helper_linux'))
      candidates.push(join(app.getAppPath(), '..', 'Xkey', 'build', 'xkey_helper_linux'))
    }
    for (const p of candidates) {
      if (existsSync(p)) return p
    }
    throw new Error('找不到 xkey_helper_linux，请检查路径')
  }

  public async autoGetDbKey(): Promise<DbKeyResult> {
    try {
      console.log('[Linux KeyService] 1. 尝试结束当前微信进程...')
      await execAsync('killall -9 wechat wechat-bin xwechat').catch(() => {})
      // 稍微等待进程完全退出
      await new Promise(r => setTimeout(r, 1000))

      console.log('[Linux KeyService] 2. 尝试拉起微信...')
      const startCmds = [
        'nohup wechat >/dev/null 2>&1 &',
        'nohup wechat-bin >/dev/null 2>&1 &',
        'nohup xwechat >/dev/null 2>&1 &'
      ]
      for (const cmd of startCmds) execAsync(cmd).catch(() => {})

      console.log('[Linux KeyService] 3. 等待微信进程出现...')
      let pid = 0
      for (let i = 0; i < 15; i++) { // 最多等 15 秒
        await new Promise(r => setTimeout(r, 1000))
        const { stdout } = await execAsync('pidof wechat wechat-bin xwechat').catch(() => ({ stdout: '' }))
        const pids = stdout.trim().split(/\s+/).filter(p => p)
        if (pids.length > 0) {
          pid = parseInt(pids[0], 10)
          break
        }
      }

      if (!pid) {
        return { success: false, error: '未能自动启动微信，请手动启动并登录。' }
      }

      console.log(`[Linux KeyService] 4. 捕获到微信 PID: ${pid}，准备获取密钥...`)

      await new Promise(r => setTimeout(r, 2000))

      return await this.getDbKey(pid)
    } catch (err: any) {
      return { success: false, error: '自动获取微信 PID 失败: ' + err.message }
    }
  }

  public async getDbKey(pid: number): Promise<DbKeyResult> {
    try {
      const helperPath = this.getHelperPath()
      const { stdout: scanOut } = await execFileAsync(helperPath, ['db_scan', pid.toString()])
      const scanRes = JSON.parse(scanOut.trim())

      if (!scanRes.success) {
        return { success: false, error: scanRes.result || '扫描失败，请确保微信已完全登录' }
      }
      const targetAddr = scanRes.target_addr

      return await new Promise((resolve) => {
        const options = { name: 'WeFlow' }
        const command = `"${helperPath}" db_hook ${pid} ${targetAddr}`

        sudo.exec(command, options, (error, stdout) => {
          execAsync(`kill -CONT ${pid}`).catch(() => {})
          if (error) {
            resolve({ success: false, error: `授权失败或被取消: ${error.message}` })
            return
          }
          try {
            const hookRes = JSON.parse((stdout as string).trim())
            if (hookRes.success) {
              resolve({ success: true, key: hookRes.key })
            } else {
              resolve({ success: false, error: hookRes.result })
            }
          } catch (e) {
            resolve({ success: false, error: '解析 Hook 结果失败' })
          }
        })
      })
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }

  public async autoGetImageKey(
      accountPath?: string,
      onProgress?: (msg: string) => void,
      wxid?: string
  ): Promise<ImageKeyResult> {
    try {
      if (onProgress) onProgress('正在初始化...');
      const helperPath = this.getHelperPath()
      const { stdout } = await execFileAsync(helperPath, ['image_local'])
      const res = JSON.parse(stdout.trim())
      if (!res.success) return { success: false, error: res.result }

      const accounts = res.data.accounts || []
      let account = accounts.find((a: any) => a.wxid === wxid)
      if (!account && accounts.length > 0) account = accounts[0]

      if (account && account.keys && account.keys.length > 0) {
        if (onProgress) onProgress('已找到匹配的图片密钥');
        const keyObj = account.keys[0]
        return { success: true, xorKey: keyObj.xorKey, aesKey: keyObj.aesKey }
      }
      return { success: false, error: '未在缓存中找到匹配的图片密钥' }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }

  public async autoGetImageKeyByMemoryScan(
      accountPath: string,
      onProgress?: (msg: string) => void
  ): Promise<ImageKeyResult> {
    try {
      if (onProgress) onProgress('正在获取微信进程...');
      const { stdout } = await execAsync('pidof wechat wechat-bin xwechat').catch(() => ({ stdout: '' }))
      const pids = stdout.trim().split(/\s+/).filter(p => p)
      if (pids.length === 0) return { success: false, error: '微信未运行，无法扫描内存' }
      const pid = parseInt(pids[0], 10)

      if (onProgress) onProgress('正在提取图片特征码...');
      const ciphertextHex = this.findAnyDatCiphertext(accountPath)
      if (!ciphertextHex) {
        return { success: false, error: '未在 FileStorage/Image 找到缓存图片，请在微信中随便点开一张大图后重试' }
      }

      if (onProgress) onProgress('正在提权扫描进程内存...');
      const helperPath = this.getHelperPath()
      const { stdout: memOut } = await execFileAsync(helperPath, ['image_mem', pid.toString(), ciphertextHex])
      const res = JSON.parse(memOut.trim())

      if (res.success) {
        if (onProgress) onProgress('内存扫描成功');
        return { success: true, aesKey: res.key }
      }
      return { success: false, error: res.result }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }
  private findAnyDatCiphertext(accountPath: string): string | null {
    try {
      const imgDir = join(accountPath, 'FileStorage', 'Image')
      if (!existsSync(imgDir)) return null

      const months = readdirSync(imgDir).filter(f => !f.startsWith('.') && statSync(join(imgDir, f)).isDirectory())
      months.sort((a, b) => b.localeCompare(a))

      for (const month of months) {
        const monthDir = join(imgDir, month)
        const files = readdirSync(monthDir).filter(f => f.endsWith('.dat'))
        if (files.length > 0) {
          const target = join(monthDir, files[0])
          const buffer = readFileSync(target)
          if (buffer.length >= 16) {
            return buffer.subarray(0, 16).toString('hex')
          }
        }
      }
    } catch (e) {
      console.error('[Linux KeyService] 查找 .dat 失败:', e)
    }
    return null
  }
}