/**
 * The fish integration (§7): a vendor_conf.d snippet found through XDG_DATA_DIRS,
 * Ghostty's technique. fish sources vendor snippets before the user's config.fish,
 * though user conf.d files can precede them; the initial key is therefore a private
 * PID file, never an environment variable visible to those earlier files' children.
 * The handshake mark goes out before config.fish (`--init-command` would run after it).
 *
 * Written as a template literal: `$\{` below would be the shell's `${` (fish has
 * none), `\\` is one backslash.
 */
export const FISH_CONF = `# --- tsm shell integration (fish) --- generated; do not edit
#
# XDG_DATA_DIRS pointed here for this one startup; it is restored at once, so
# programs and nested shells see the user's value. Every mark ends in ";k=<key>":
# the key is read from this PID's private file into a global unexported variable.
# The hooks are fish events: fish_preexec (E, C), fish_postexec (D), fish_prompt
# and fish_cancel (cwd, A), and a fish_prompt wrapper that ends the prompt with B.
# An "exec fish" (or "exec bash", "exec zsh") re-integrates: the pid it keeps is the
# check (nested shells fail it). Daemon lines are " eval (__tsm_collect '<file>' $status)":
# the file's text runs at the prompt's own level, so its jobs get process groups of their
# own (cancel reaches them, never fish) and "set -l" lasts as when typed.
set -l __tsm_here (string replace -r '/fish/vendor_conf.d/[^/]*$' '' -- (status filename))
# What an armed exec in a bash or zsh of this session exported for the shell it became:
# the user's own values come back.
if test "$PROMPT_COMMAND" = ' . "$TSM_BASH_RC" reinit'
    set -e PROMPT_COMMAND
end
if set -q ZDOTDIR; and test "$ZDOTDIR" = "$__tsm_here"
    if set -q TSM_USER_ZDOTDIR
        set -gx ZDOTDIR "$TSM_USER_ZDOTDIR"
    else
        set -e ZDOTDIR
    end
end
set -e TSM_BASH_RC TSM_USER_ZDOTDIR
set -l __tsm_spath
set -l __tsm_spath_set
if set -q TSM_SESSION_PATH
    set __tsm_spath "$TSM_SESSION_PATH"
    set __tsm_spath_set 1
    set -e TSM_SESSION_PATH
end
set -l __tsm_user_dirs
if set -q TSM_XDG_DATA_DIRS
    set __tsm_user_dirs "$TSM_XDG_DATA_DIRS"
    if test -n "$TSM_XDG_DATA_DIRS"
        set -gx XDG_DATA_DIRS "$TSM_XDG_DATA_DIRS"
    else
        set -e XDG_DATA_DIRS
    end
    set -e TSM_XDG_DATA_DIRS
end
set -l __tsm_empty_config
set -l __tsm_user_config
if set -q TSM_XDG_CONFIG_HOME
    set __tsm_empty_config "$XDG_CONFIG_HOME"
    set __tsm_user_config "$TSM_XDG_CONFIG_HOME"
    if test -n "$TSM_XDG_CONFIG_HOME"
        set -gx XDG_CONFIG_HOME "$TSM_XDG_CONFIG_HOME"
    else
        set -e XDG_CONFIG_HOME
    end
    set -e TSM_XDG_CONFIG_HOME
end
# The key is this process's only: read from its private file, which is then removed.
set -lu __tsm_k
if test -r "$__tsm_here/key-$fish_pid"
    read __tsm_k < "$__tsm_here/key-$fish_pid"
    /bin/rm -f -- "$__tsm_here/key-$fish_pid"
end
set -e TSM_NO_USER_RC TSM_HISTFILE
if test -n "$__tsm_k"; and not set -q __tsm_key; and status is-interactive
    set -gu __tsm_key $__tsm_k
    set -g __tsm_dir $__tsm_here
    set -g __tsm_user_dirs $__tsm_user_dirs
    set -g __tsm_empty_config $__tsm_empty_config
    set -g __tsm_user_config $__tsm_user_config
    if test -n "$__tsm_spath_set"
        set -g __tsm_session_path $__tsm_spath
    end

    # The handshake: integration is loading; the daemon waits for the first prompt.
    printf '\\e]633;P;TsmHello=fish;k=%s\\a' $__tsm_key

    function __tsm_osc
        printf '\\e]%s;k=%s\\a' $argv[1] $__tsm_key
    end
    # VS Code's value escaping: \\ ; and the controls that would end an OSC.
    function __tsm_escape
        set -l s (string replace -a -- '\\\\' '\\\\\\\\' $argv[1] | string collect)
        set s (string replace -a -- ';' '\\\\x3b' $s | string collect)
        set s (string replace -a -- \\n '\\\\x0a' $s | string collect)
        set s (string replace -a -- \\r '\\\\x0d' $s | string collect)
        set s (string replace -a -- \\a '\\\\x07' $s | string collect)
        set s (string replace -a -- \\e '\\\\x1b' $s | string collect)
        printf '%s' $s
    end
    # What a daemon line runs: the file's text, evaluated at the prompt's own level, with the
    # status the prompt had (G6: $status is the last command's, as when typed).
    function __tsm_collect
        string collect < $argv[1]
        return $argv[2]
    end
    # What the accepted line runs: for a daemon line (" eval (__tsm_collect '<tmp>/tsm-cmd-…' $status)")
    # the file's text.
    function __tsm_text
        set -l m (string match -r "^\\s*(?:eval \\(__tsm_collect |source )'(.*tsm-cmd-[^/]*)'(?: [\\$]status\\))?\\s*\\$" -- $argv[1])
        if set -q m[2]
            set -l f (string replace -a -- "'\\\\''" "'" $m[2])
            set -l t
            read -lz t < $f 2>/dev/null
            printf '%s' $t
        else
            printf '%s' $argv[1]
        end
    end
    function __tsm_preexec --on-event fish_preexec
        __tsm_osc "633;E;$(__tsm_escape $argv[1])"
        __tsm_osc '133;C'
        set -g __tsm_in_cmd 1
        if string match -qr '(?m)(^|[\\s;&|(])exec(\\s|$)' -- (__tsm_text $argv[1] | string collect)
            __tsm_exec_arm
        end
    end
    function __tsm_postexec --on-event fish_postexec
        set -l st $status
        if set -q __tsm_exec_armed; __tsm_exec_disarm; end
        if test -n "$__tsm_in_cmd"
            __tsm_osc "133;D;$st"
            set -g __tsm_in_cmd ''
        end
    end
    # An exec replaces this process: tell the daemon (it watches whether the program that
    # follows is a shell that re-integrates, ss-4), and export what a fresh shell of ours
    # needs — fish this snippet, bash a PROMPT_COMMAND that sources its rc beside it, zsh
    # the shim directory — with the key (same pid, so the check passes). Disarmed after
    # the command if the exec did not happen.
    function __tsm_exec_arm
        set -g __tsm_exec_armed 1
        __tsm_osc '633;P;TsmExec=1'
        set -g __tsm_had_zdotdir (set -q ZDOTDIR; and echo 1)
        set -g __tsm_saved_zdotdir "$ZDOTDIR"
        set -g __tsm_had_pc (set -q PROMPT_COMMAND; and echo 1)
        set -g __tsm_saved_pc "$PROMPT_COMMAND"
        if set -q ZDOTDIR
            set -gx TSM_USER_ZDOTDIR "$ZDOTDIR"
        end
        set -gx ZDOTDIR $__tsm_dir
        set -gx TSM_BASH_RC $__tsm_dir/bash-rc.sh
        set -gx PROMPT_COMMAND ' . "$TSM_BASH_RC" reinit'
        if test -n "$__tsm_empty_config"
            set -gx TSM_NO_USER_RC 1
        end
        begin
            set -l old_umask (umask)
            umask 077
            printf '%s\\n' "$__tsm_key" > "$__tsm_dir/key-$fish_pid"
            umask $old_umask
        end
        set -gx TSM_XDG_DATA_DIRS "$__tsm_user_dirs"
        if test -n "$__tsm_user_dirs"
            set -gx XDG_DATA_DIRS "$__tsm_dir:$__tsm_user_dirs"
        else
            set -gx XDG_DATA_DIRS "$__tsm_dir:/usr/local/share:/usr/share"
        end
        if test -n "$__tsm_empty_config"
            set -gx TSM_XDG_CONFIG_HOME "$__tsm_user_config"
            set -gx XDG_CONFIG_HOME "$__tsm_empty_config"
        end
    end
    function __tsm_exec_disarm
        /bin/rm -f -- "$__tsm_dir/key-$fish_pid"
        set -e __tsm_exec_armed TSM_XDG_DATA_DIRS TSM_BASH_RC TSM_USER_ZDOTDIR TSM_NO_USER_RC
        if test -n "$__tsm_had_zdotdir"
            set -gx ZDOTDIR "$__tsm_saved_zdotdir"
        else
            set -e ZDOTDIR
        end
        if test -n "$__tsm_had_pc"
            set -gx PROMPT_COMMAND "$__tsm_saved_pc"
        else
            set -e PROMPT_COMMAND
        end
        if test -n "$__tsm_user_dirs"
            set -gx XDG_DATA_DIRS "$__tsm_user_dirs"
        else
            set -e XDG_DATA_DIRS
        end
        if test -n "$__tsm_empty_config"
            set -e TSM_XDG_CONFIG_HOME
            if test -n "$__tsm_user_config"
                set -gx XDG_CONFIG_HOME "$__tsm_user_config"
            else
                set -e XDG_CONFIG_HOME
            end
        end
    end
    function __tsm_prompt_end
        printf '\\e]133;B;k=%s\\a' $__tsm_key
    end
    # B at the end of the prompt, re-wrapped when a theme redefined fish_prompt.
    function __tsm_wrap_prompt
        if functions -q fish_prompt; and not string match -q '*__tsm_prompt_end*' -- (functions fish_prompt)
            functions -e __tsm_user_prompt
            functions -c fish_prompt __tsm_user_prompt
            function fish_prompt
                __tsm_user_prompt
                __tsm_prompt_end
            end
        end
    end
    # ss-1: the daemon types ctrl-alt-shift-F12 and -F11 before every line: whatever the
    # editor holds, in whichever mode, is gone first (vi modes come back to insert).
    function __tsm_clear_line
        commandline -r ''
        if string match -q '*vi*' -- "$fish_key_bindings"; and test "$fish_bind_mode" != insert
            set fish_bind_mode insert
            commandline -f repaint-mode
        end
    end
    # (fish 4 decodes keys and binds them by name; fish 3 binds the raw sequences.)
    function __tsm_bind_clear
        set -l old (string match -qr '^[0-3]\\.' -- $version; and echo 1)
        for m in default insert visual
            if test -n "$old"
                bind -M $m \\e\\[24\\;8~ __tsm_clear_line 2>/dev/null
                bind -M $m \\e\\[23\\;8~ __tsm_clear_line 2>/dev/null
            else
                bind -M $m ctrl-alt-shift-f12 __tsm_clear_line 2>/dev/null
                bind -M $m ctrl-alt-shift-f11 __tsm_clear_line 2>/dev/null
            end
        end
    end
    function __tsm_rebind_clear --on-variable fish_key_bindings
        __tsm_bind_clear
    end
    # G6, ux-3: a history tool config.fish loaded (atuin, mcfly, hishtory) must not open the
    # user's global history on Up or ctrl-r: its bindings go, and fish's own (which search
    # this session's in-memory history) apply again.
    function __tsm_own_history_keys
        set -l keys ctrl-r up
        if string match -qr '^[0-3]\\.' -- $version
            set keys \\cr '-k up'
        end
        for m in default insert visual
            for k in $keys
                set -l key (string split ' ' -- $k)
                if string match -qr 'atuin|mcfly|hishtory|hstr' -- (bind -M $m $key 2>/dev/null)
                    bind -e -M $m $key 2>/dev/null
                end
            end
        end
    end
    # At the first prompt, after config.fish: ss-7's PATH (a PATH the session was created
    # with comes first again, in its own order, after fish's login config and the user's
    # config reordered it), the user's history keys, and the clear keys.
    function __tsm_after_config
        functions -e __tsm_after_config
        if set -q __tsm_session_path
            set -l given (string split -- : "$__tsm_session_path" | string match -v -- '')
            set -l rest
            for p in $PATH
                contains -- $p $given; or set -a rest $p
            end
            set -gx PATH $given $rest
            set -e __tsm_session_path
        end
        __tsm_own_history_keys
        __tsm_bind_clear
    end
    function __tsm_prompt_start --on-event fish_prompt --on-event fish_cancel
        if functions -q __tsm_after_config
            __tsm_after_config
        end
        __tsm_osc "633;P;Cwd=$(__tsm_escape $PWD)"
        __tsm_osc '133;A'
        __tsm_wrap_prompt
        # fish keeps history under the user's data dir, never per session: keep this
        # session's out of it entirely (it stays available in memory). The daemon's
        # own lines start with a space, which fish never records.
        set -g fish_history ''
    end
    set -g __tsm_in_cmd ''
    set -g fish_history ''
    __tsm_bind_clear
end
`;
