import { join } from 'path'
import { open } from 'fs/promises'
import { DEFAULT_CONFIG } from './constants.js'
import { pathToFileURL } from 'url'

const configFileOptions = ['rage.config.js', 'rage.config.json', 'rage.config', 'rage.json', 'rage.js']

let config = DEFAULT_CONFIG
const cwd = process.cwd()

const tryRead = async (path) => {
  try {
    const fd = await open(path)
    const data = await fd.read()
    await fd.close()
    return data
  } catch (error) {}
}

const tryReadConfig = async (path) => {
  const files = configFileOptions.map((file) => join(path, file))
  let data
  for (const file of files) {
    try {
      if (file.endsWith('.js')) {
        data = (await import(pathToFileURL(file) as unknown as string)).default
        if (data) {
          console.log('config file found at', file)
          return data
        }
      } else {
        data = await tryRead(file)
        if (data) {
          console.log('config file found at', file)
          data = data.buffer.toString()
          data = JSON.parse(data)
          return data
        }
      }
    } catch (error) {}
  }
  return data
}
try {
  const result = await tryReadConfig(cwd)
  if (result) {
    config = { ...DEFAULT_CONFIG, ...result }
  }
} catch (error) {
  console.error(error)
}

export default config
