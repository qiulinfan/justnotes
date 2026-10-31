import { usage } from "./output";
import { BUILTINS, type CommandSpec, flagsOf } from "./spec";

// Shell completion for `justnotes`, generated from the command table:
// command names, then each command's flags (key= for a parameter, the bare
// word for a switch, key=value for each choice of an enumerated parameter).
// Plugin commands are not included: they exist only while the app runs.

const GLOBAL = ["--profile", "--offline", "--copy", "--json", "vault="];

interface Word {
	word: string;
	description: string;
}

function choices(value: string | undefined) {
	return value && /^[A-Za-z]+(\|[A-Za-z]+)+$/.test(value) ? value.split("|") : null;
}

function flagWords(spec: CommandSpec): Word[] {
	return Object.entries(flagsOf(spec)).flatMap(([key, flag]) => {
		const values = choices(flag.value);
		if (values) return values.map((v) => ({ word: `${key}=${v}`, description: flag.description }));
		return [{ word: flag.value ? `${key}=` : key, description: flag.description }];
	});
}

const commands = () => [...BUILTINS.values()];

const single = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function zsh() {
	const escape = (s: string) => s.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
	const lines = [
		"#compdef justnotes",
		"# justnotes completion for zsh: justnotes completion zsh > ~/.zfunc/_justnotes",
		"_justnotes() {",
		"  local cmd i",
		"  for (( i = 2; i < CURRENT; i++ )); do",
		"    case ${words[i]} in",
		"      --profile) (( i++ )) ;;",
		"      --*|vault=*) ;;",
		"      *) cmd=${words[i]}; break ;;",
		"    esac",
		"  done",
		"  local -a items spaced",
		'  if [[ -z $cmd ]]; then',
		"    items=(",
		...commands().map((s) => `      ${single(`${escape(s.name)}:${s.description}`)}`),
		"    )",
		`    spaced=(${GLOBAL.filter((g) => !g.endsWith("=")).join(" ")})`,
		"    _describe 'command' items",
		"    compadd -a spaced",
		"    compadd -S '' vault=",
		"    return",
		"  fi",
		"  local -a valued switches",
		"  case $cmd in",
		...commands().map((spec) => {
			const words = flagWords(spec);
			const valued = words.filter((w) => w.word.endsWith("="));
			const switches = words.filter((w) => !w.word.endsWith("="));
			const list = (ws: Word[]) => ws.map((w) => single(`${escape(w.word)}:${w.description}`)).join(" ");
			return `    (${spec.name.replace(/:/g, "\\:")}) valued=(${list(valued)}); switches=(${list(switches)}) ;;`;
		}),
		"  esac",
		"  _describe 'parameter' valued -S ''",
		"  _describe 'flag' switches",
		"  compadd -- --copy",
		"}",
		'compdef _justnotes justnotes',
	];
	return lines.join("\n");
}

function fish() {
	const escape = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
	const lines = [
		"# justnotes completion for fish: justnotes completion fish > ~/.config/fish/completions/justnotes.fish",
		"function __justnotes_command",
		"    set -l words (commandline -opc)",
		"    set -e words[1]",
		"    while set -q words[1]",
		"        switch $words[1]",
		"            case --profile",
		"                set -e words[1]",
		"            case '--*' 'vault=*'",
		"            case '*'",
		"                echo $words[1]",
		"                return",
		"        end",
		"        set -e words[1]",
		"    end",
		"end",
		"function __justnotes_is",
		"    set -l cmd (__justnotes_command)",
		'    test "$cmd" = "$argv[1]"',
		"end",
		"complete -c justnotes -f",
		"complete -c justnotes -n '__justnotes_is \"\"' -l profile -r -F -d 'Profile folder of the instance'",
		"complete -c justnotes -n '__justnotes_is \"\"' -l offline -d 'Read the vault folder, never the app'",
		"complete -c justnotes -n '__justnotes_is \"\"' -a 'vault=' -d 'Vault name or path'",
		"complete -c justnotes -l copy -d 'Also copy the output'",
		...commands().map((s) => `complete -c justnotes -n '__justnotes_is \"\"' -a '${escape(s.name)}' -d '${escape(s.description)}'`),
		...commands().flatMap((spec) =>
			flagWords(spec).map((w) => `complete -c justnotes -n '__justnotes_is ${escape(spec.name)}' -a '${escape(w.word)}' -d '${escape(w.description)}'`),
		),
	];
	return lines.join("\n");
}

function bash() {
	const cases = commands().map((spec) => `    ${spec.name}) words=${single(flagWords(spec).map((w) => w.word).join(" "))} ;;`);
	const lines = [
		"# justnotes completion for bash: source <(justnotes completion bash)",
		"_justnotes() {",
		'  local line=${COMP_LINE:0:COMP_POINT} cur="" cmd="" words w',
		"  local -a parts",
		'  read -ra parts <<< "$line"',
		'  [[ $line != *" " ]] && cur=${parts[${#parts[@]}-1]} && unset "parts[${#parts[@]}-1]"',
		"  local i=1",
		"  while (( i < ${#parts[@]} )); do",
		'    w=${parts[i]}',
		'    case $w in',
		"      --profile) (( i++ )) ;;",
		"      --*|vault=*) ;;",
		'      *) cmd=$w; break ;;',
		"    esac",
		"    (( i++ ))",
		"  done",
		'  if [[ -z $cmd ]]; then',
		`    words=${single([...commands().map((s) => s.name), ...GLOBAL].join(" "))}`,
		"  else",
		'    case $cmd in',
		...cases,
		"      *) words='' ;;",
		"    esac",
		'    words="$words --copy"',
		"  fi",
		'  COMPREPLY=($(compgen -W "$words" -- "$cur"))',
		// bash splits words at = and :, so replies drop what precedes the last one.
		'  local wb=${cur%"${cur##*[=:]}"}',
		'  [[ -n $wb ]] && COMPREPLY=("${COMPREPLY[@]#"$wb"}")',
		'  [[ ${#COMPREPLY[@]} -eq 1 && ${COMPREPLY[0]} == *= ]] && compopt -o nospace',
		"}",
		"complete -F _justnotes justnotes",
	];
	return lines.join("\n");
}

export function completionScript(shell: string) {
	if (shell === "zsh") return zsh();
	if (shell === "fish") return fish();
	if (shell === "bash") return bash();
	throw usage("Give the shell: justnotes completion zsh|fish|bash");
}
