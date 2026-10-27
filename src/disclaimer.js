/**
 * The disclaimer copy both surfaces show: the plugin's settings page and the
 * standalone/desktop console.
 *
 * The product carries the WorkBuddy China build, the WorkBuddy international
 * build and Huawei Cloud's CodeArts plan, all three as ordinary channels with
 * their own adapter. An earlier version excluded them; this copy exists to say
 * so plainly, so a user who reads it does not go looking for a switch, and to
 * keep the responsibility boundary stated: anything a user does with any
 * channel is their own responsibility.
 *
 * The copy is data, not markup: each surface renders it in its own idiom, so
 * there is exactly one place to change what the product says. It is deliberately
 * short — a wall of legal text is read by nobody — and states the project's
 * purpose plainly, because that is the honest description of what it is.
 */

export const DISCLAIMER_VERSION = 3

/** Channels this build offers. Named for the reader, in the order they are listed. */
export const EXCLUDED_CHANNELS = Object.freeze([])

export const DISCLAIMER = Object.freeze({
  version: DISCLAIMER_VERSION,
  title: '使用须知与免责声明',
  subtitle: '关于本插件提供的渠道，以及你需要知道的责任边界',
  intro: '本插件是一个个人学习与技术研究项目，用于学习模型网关、协议适配与本地路由的实现方式，按「现状」提供，不构成任何商业服务或产品承诺。',
  sections: Object.freeze([
    {
      id: 'channels',
      heading: '这三个渠道已恢复',
      body: '本插件包含 WorkBuddy 国内版（workbuddy，亦称 CodeBuddy）、WorkBuddy 国际版（workbuddy-ai）与华为云 CodeArts（codearts，码道）三个渠道，与其余渠道一样出现在渠道列表、模型目录与设置页里，可以正常登录、签到与调用。早期版本曾移除它们，现已恢复；如果你此前找不到它们，升级后重新打开即可看到。',
    },
    {
      id: 'responsibility',
      heading: '使用第三方渠道请自行判断',
      body: '上述渠道以及你在本插件之外接入的任何第三方服务，其可用性、配额、定价与条款均由对应服务商决定，可能随时变化或终止。我们不为这些外部服务的可用性、合规性或任何后果提供担保，也不参与其运营。',
    },
    {
      id: 'accounts',
      heading: '账号与凭据由你自己负责',
      body: '本插件只在你本机保存你主动导入的凭据，不会上传到任何服务器。请确保你使用这些账号的方式符合对应服务商的条款与所在地法律；由此产生的封禁、扣费、数据风险或其他损失，由使用者自行承担。',
    },
    {
      id: 'no-warranty',
      heading: '不提供任何担保',
      body: '本项目不对正确性、稳定性、适销性或特定用途适用性作任何明示或默示担保。使用本插件造成的任何直接或间接损失，作者与团队均不承担责任。请自行评估风险，并优先遵守所在地区的法律法规与服务商协议。',
    },
    {
      id: 'lawful',
      heading: '请合法合规使用',
      body: '本项目仅用于个人学习与技术研究。请勿将其用于违反服务商条款、规避授权限制、批量滥用额度或其他违法用途。因使用方式不当引发的争议、索赔或法律责任，均由使用者自行承担。',
    },
  ]),
  accept: '我已阅读并了解',
  reopen: '查看免责声明',
})

/** Whether a stored acknowledgement matches the current copy version. */
export function disclaimerAcknowledged(settings) {
  return Number(settings?.disclaimerAck) === DISCLAIMER_VERSION
}
