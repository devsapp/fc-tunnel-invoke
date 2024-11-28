import { loadComponent, lodash as _ } from '@serverless-devs/core';
import { addEnv } from '../local-invoke/env';
import logger from '../../common/logger';
import { getUserIdAndGroupId } from '../definition';
import nestedObjectAssign from 'nested-object-assign';
import { isCustomContainerRuntime } from '../utils/runtime';
import { mark } from '../utils/utils';

const NAS_UID: number = 10003;
const NAS_GID: number = 10003;


// Not Run stage:
//  for linux platform, it will always use process.uid and process.gid
//  for mac and windows platform, it will always use 0
// Run stage:
//  for linux platform, it will always use process.uid and process.gid
//  for mac and windows platform, it will use 10003 if no nasConfig, otherwise it will use nasConfig userId
export function resolveDockerUser({nasConfig, stage = 'run'}): string {
  let { userId, groupId } = getUserIdAndGroupId(nasConfig);

  if (process.platform === 'linux') {
    logger.debug('For linux platform, Fc will use host userId and groupId to build or run your functions');
    userId = process.getuid();
    groupId = process.getgid();
  } else {
    if (stage === 'run') {
      if (userId === -1 || userId === undefined) {
        userId = NAS_UID;
      }
      if (groupId === -1 || groupId === undefined) {
        groupId = NAS_GID;
      }
    } else {
      userId = 0;
      groupId = 0;
    }
  }

  return `${userId}:${groupId}`;
}

export function transformMountsForToolbox(mounts) {

  console.warn(`We detected that you are using docker toolbox. For a better experience, please upgrade 'docker for windows'.\nYou can refer to Chinese doc https://github.com/devsapp/fc/issues/867 .\n`);

  if (Array.isArray(mounts)) {
    return mounts.map(m => {

      return transformSourcePathOfMount(m);
    });
  }
  return transformSourcePathOfMount(mounts);
}

function transformSourcePathOfMount(mountsObj) {

  if (!_.isEmpty(mountsObj)) {

    const replaceMounts = Object.assign({}, mountsObj);
    replaceMounts.Source = transformPathForVirtualBox(mountsObj.Source);
    return replaceMounts;
  }
  return {};
}

export function transformPathForVirtualBox(source) {
  // C:\\Users\\image_crawler\\code -> /c/Users/image_crawler/code
  const sourcePath = source.split(':').join('');
  const lowerFirstAndReplace = _.lowerFirst(sourcePath.split('\\').join('/'));
  return '/' + lowerFirstAndReplace;
}

export async function generateLocalStartOpts(proxyContainerName: string, runtime, name, mounts, cmd, envs, limitedHostConfig, { debugPort, dockerUser, debugIde = null, imageName }) {
  if (isCustomContainerRuntime(runtime)) {
    return genCustomContainerLocalStartOpts(proxyContainerName, name, mounts, cmd, envs, imageName,limitedHostConfig);
  }
  return await genNonCustomContainerLocalStartOpts(proxyContainerName, runtime, name, mounts, cmd, debugPort, envs, dockerUser, debugIde, limitedHostConfig);
}

async function genNonCustomContainerLocalStartOpts(proxyContainerName, runtime, name, mounts, cmd, _debugPort, envs, dockerUser, _debugIde, limitedHostConfig) {
  const { Memory, Ulimits, CpuPeriod, CpuQuota } = limitedHostConfig;
  const hostOpts: any = {
    HostConfig: {
      AutoRemove: true,
      Mounts: mounts,
      Privileged: true,
      Memory,
      Ulimits,
      CpuPeriod,
      CpuQuota
    }
  };
  if (!_.isEmpty(proxyContainerName)) {
    hostOpts.HostConfig.NetworkMode = `container:${proxyContainerName}`;
  }


  const imageName = await resolveRuntimeToDockerImage(runtime);

  supportCustomBootstrapFile(runtime, envs);

  const opts = nestedObjectAssign(
    {
      Env: resolveDockerEnv(envs),
      Image: imageName,
      name,
      Cmd: cmd,
      User: dockerUser,
      Entrypoint: [resolveMockScript(runtime)]
    },
    hostOpts);
  const encryptedOpts: any = encryptDockerOpts(opts);

  logger.debug(`docker options: ${JSON.stringify(encryptedOpts, null, '  ')}`);
  return opts;
}

// /**
//  * 支持通过 BOOTSTRAP_FILE 环境变量改变 bootstrap 文件名。
// **/
function supportCustomBootstrapFile(runtime, envs) {
  if (runtime === 'custom') {
    if (envs['BOOTSTRAP_FILE']) {
      envs['AGENT_SCRIPT'] = envs['BOOTSTRAP_FILE'];
    }
  }
}

export function resolveMockScript(runtime: string): string {
  if(runtime=='python3.9'){
    return `/var/fc/runtime/python3/mock`;
  }
  return `/var/fc/runtime/${runtime}/mock`;
}

function encryptDockerOpts(dockerOpts: any): any {
  const encryptedOpts: any = _.cloneDeep(dockerOpts);
  if (encryptedOpts?.Env) {
    const encryptedEnv: any = encryptedOpts.Env.map((e: string) => {
      if (e.startsWith("FC_ACCESS_KEY_ID") || e.startsWith("FC_ACCESS_KEY_SECRET") || e.startsWith("FC_ACCOUNT_ID")) {
        const keyValueList: string[] = e.split('=');
        const encrptedVal: string = mark(keyValueList[1]);
        return `${keyValueList[0]}=${encrptedVal}`;
      } else {
        return e;
      }
    });
    encryptedOpts.Env = encryptedEnv;
  }
  return encryptedOpts;
}

function genCustomContainerLocalStartOpts(proxyContainerName, name, mounts, cmd, envs, imageName, limitedHostConfig) {
  const { Memory, Ulimits, CpuPeriod, CpuQuota } = limitedHostConfig;
  const hostOpts: any = {
    HostConfig: {
      AutoRemove: true,
      Mounts: mounts,
      Privileged: true,
      Memory,
      Ulimits,
      CpuPeriod,
      CpuQuota
    }
  };
  if (!_.isEmpty(proxyContainerName)) {
    hostOpts.HostConfig.NetworkMode = `container:${proxyContainerName}`;
  }

  const opts: any = {
    Env: resolveDockerEnv(envs, true),
    Image: imageName,
    name
  };
  // @ts-ignore
  if (cmd !== []) {
    opts.Cmd = cmd;
  }
  const ioOpts = {
    OpenStdin: true,
    Tty: false,
    StdinOnce: true,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true
  };
  const dockerOpts = nestedObjectAssign(opts, hostOpts, ioOpts);
  const encryptedOpts: any = encryptDockerOpts(dockerOpts);

  logger.debug(`docker options for custom container: ${JSON.stringify(encryptedOpts, null, '  ')}`);
  return dockerOpts;
}


export function resolveDockerEnv(envs = {}, isCustomContainer = false): string[] {
  if (isCustomContainer) {
    return _.map(envs || {}, (v, k) => `${k}=${v}`);
  }
  return _.map(addEnv(envs || {}), (v, k) => `${k}=${v}`);
}

export async function resolveRuntimeToDockerImage(runtime: string): Promise<string> {
  const fcCore = await loadComponent('devsapp/fc-core');
  return await fcCore.resolveRuntimeToDockerImage?.(runtime, false);
}
