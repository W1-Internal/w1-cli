import { cmd } from "./cmd"
import { W1Auth } from "@/w1/auth"

const color = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  lime: "\x1b[38;5;190m",
}

type AuthArgs = {
  action: "login" | "logout" | "status"
}

export const AuthCommand = cmd<{}, AuthArgs>({
  command: "auth <action>",
  describe: "manage the shared W1 browser session",
  builder: (yargs) =>
    yargs.positional("action", {
      type: "string",
      choices: ["login", "logout", "status"] as const,
      demandOption: true,
    }),
  handler: (args) => runAction(args.action),
})

export const LoginCommand = cmd({
  command: "login",
  describe: "sign in to W1 in your browser",
  handler: () => runAction("login"),
})

export const LogoutCommand = cmd({
  command: "logout",
  describe: "revoke and remove the shared W1 session",
  handler: () => runAction("logout"),
})

async function runAction(action: AuthArgs["action"]) {
  if (action === "status") {
    const session = await W1Auth.readSession()
    if (!session) {
      process.stdout.write("Not signed in. Run `w1 login`.\n")
      process.exitCode = 2
      return
    }
    process.stdout.write(`Signed in${session.email ? ` as ${session.email}` : ""}.\n`)
    process.stdout.write(`${color.dim}Shared session: ${W1Auth.sessionPath()}${color.reset}\n`)
    return
  }
  if (action === "logout") {
    const removed = await W1Auth.signOut()
    process.stdout.write(removed ? "Signed out of W1.\n" : "W1 was already signed out.\n")
    return
  }
  process.stdout.write(`${color.lime}${color.bold}W1 browser sign-in${color.reset}\n`)
  const session = await W1Auth.signIn({
    onStart(url) {
      process.stdout.write("Opening your browser. If it does not open, visit:\n")
      process.stdout.write(`${color.dim}${url}${color.reset}\n\n`)
      process.stdout.write("Waiting for sign-in…\n")
    },
  })
  process.stdout.write(`Signed in${session.email ? ` as ${session.email}` : ""}.\n`)
}
