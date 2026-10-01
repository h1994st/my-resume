% resume.cls: single-column resume class. Layout, colour, fonts, and section order live here;
% resume files contain only content. See CLAUDE.md for the authoring API.
% Hand-formatted: tex-fmt is not run on this file.
\NeedsTeXFormat{LaTeX2e}
\ProvidesClass{resume}[2026/09/30 Single-column resume class]
\LoadClass[10pt]{article}

% ---------------------------------------------------------------------------
% Page, fonts, colours
% ---------------------------------------------------------------------------
\RequirePackage[letterpaper, margin=0.6in, footskip=0.32in]{geometry}
\RequirePackage{fontspec}
\RequirePackage{xcolor}
\RequirePackage{tikz}
\RequirePackage{framed}
\RequirePackage{enumitem}
\RequirePackage[hidelinks]{hyperref}

\defaultfontfeatures{Ligatures=TeX}
\setmainfont{SourceSerif4SmText}[
  Path = ./fonts/SourceSerif4/, Extension = .otf,
  UprightFont = *-Regular, ItalicFont = *-It,
  BoldFont = *-Semibold, BoldItalicFont = *-SemiboldIt]
\setsansfont{SourceSans3}[
  Path = ./fonts/SourceSans3/, Extension = .otf,
  UprightFont = *-Regular, ItalicFont = *-It,
  BoldFont = *-Semibold, BoldItalicFont = *-SemiboldIt,
  Numbers = Tabular]
% Extract hyphens as U+002D (not U+2011) for ATS text extraction.
\XeTeXgenerateactualtext=1

\definecolor{accent}{HTML}{374151}
\colorlet{pillfill}{accent!11}
\colorlet{spinecolor}{accent!30}
\definecolor{pilltext}{HTML}{222222}
\definecolor{secondary}{HTML}{404040}
\definecolor{headlinecolor}{HTML}{333333}
\definecolor{footcolor}{HTML}{666666}

\renewcommand\normalsize{\@setfontsize\normalsize{10.5pt}{13.9pt}}
\normalsize
\setlength\parindent{0pt}
\setlength\parskip{0pt}
\hyphenpenalty=10000
\frenchspacing
\setlength\OuterFrameSep{0pt}

\newcommand\resume@namefont{\sffamily\bfseries\fontsize{28pt}{30pt}\selectfont}
\newcommand\resume@headlinefont{\sffamily\fontsize{11.5pt}{14pt}\selectfont}
\newcommand\resume@contactfont{\sffamily\fontsize{9.75pt}{12.5pt}\selectfont}
\newcommand\resume@tabfont{\sffamily\bfseries\fontsize{12pt}{14pt}\selectfont}
\newcommand\resume@titlefont{\sffamily\fontsize{11pt}{13.9pt}\selectfont}
\newcommand\resume@smallfont{\sffamily\fontsize{10pt}{12pt}\selectfont}
\newcommand\resume@footfont{\sffamily\fontsize{9pt}{11pt}\selectfont}

% Footer: "Page N of M" on every page.
\def\ps@resume{%
  \let\@oddhead\@empty\let\@evenhead\@empty
  \def\@oddfoot{\hfil\resume@footfont\color{footcolor}Page~\thepage~of~\PreviousTotalPages\hfil}%
  \let\@evenfoot\@oddfoot}
\pagestyle{resume}

% ---------------------------------------------------------------------------
% Layout building blocks (LaTeX2e syntax)
% ---------------------------------------------------------------------------

% Start a new page unless #1 of vertical space is left (keeps headings with content).
\newcommand\resume@needspace[1]{%
  \par\penalty-100
  \begingroup
    \setlength{\dimen@}{#1}%
    \dimen@ii\pagegoal \advance\dimen@ii-\pagetotal
    \ifdim\dimen@>\dimen@ii
      \ifdim\dimen@ii>\z@ \vfil\fi
      \penalty-10000
    \fi
  \endgroup}

% Section heading: solid accent tab, then a rule to the right margin.
\newcommand\resume@heading[1]{%
  \resume@needspace{8\baselineskip}%
  \addvspace{10.5pt}%
  \noindent
  \tikz[baseline=(t.base)]\node[fill=accent, text=white, rounded corners=1.5pt,
    inner xsep=7.5pt, inner ysep=2pt, font=\resume@tabfont] (t) {#1};%
  {\color{accent}\leaders\hrule height 3.6pt depth -2.5pt\hfill}%
  \par\nobreak\vspace{5pt}}

\newcommand\resume@section[2]{\resume@heading{#1}#2\par}

% Spine: a vertical line left of a section's entries; splits across pages.
\newif\ifresume@inspine
\newif\ifresume@first
\newenvironment{resume@spine}{%
  \def\FrameCommand{\hspace{3.75pt}{\color{spinecolor}\vrule width 1.5pt}\hspace{13.5pt}}%
  % Split pieces of the spine are underfull by design, and framed may overrun the
  % bottom margin by up to ~2pt when splitting; neither is visible.
  \vbadness=10000 \vfuzz=3pt
  \MakeFramed{\advance\hsize-\width \FrameRestore}%
  \resume@inspinetrue\global\resume@firsttrue}%
  {\par\endMakeFramed}
\newcommand\resume@spinesection[2]{%
  \resume@heading{#1}\begin{resume@spine}#2\end{resume@spine}}

% Ring node on the spine, placed at the start of an entry's title line.
\newcommand\resume@node{%
  \llap{\tikz[baseline={(0,-2.9pt)}]\draw[accent, line width=1.9pt, fill=white]
    (0,0) circle (3.55pt);\hspace{9.75pt}}}

% Date pill.
\newcommand\resume@pill[1]{%
  \tikz[baseline=(p.base)]\node[fill=pillfill, text=pilltext, rounded corners=6pt,
    inner xsep=5pt, inner ysep=1.2pt, font=\resume@smallfont] (p) {#1};}

% Entry: #1 bold title, #2 rest of title line, #3 dates, #4 italic sub-line (may be empty).
\newcommand\resume@entry[4]{%
  \par
  \ifresume@first\global\resume@firstfalse\else\vspace{6pt}\fi
  \noindent\ifresume@inspine\resume@node\fi
  {\interlinepenalty=10000 \resume@titlefont\textbf{#1}#2\hfill\resume@pill{#3}\par}\nobreak
  \protected@edef\resume@tmp{#4}%
  \ifx\resume@tmp\@empty\else{\itshape\resume@tmp\par}\nobreak\fi}

\newlist{resume@bullets}{itemize}{1}
\setlist[resume@bullets]{label=\textbullet, leftmargin=1.1em, labelindent=0.25em,
  labelwidth=0.45em, labelsep=*, align=left, nosep, beginpenalty=10000}

% Education line (no spine, plain dates).
\newcommand\resume@degree[4]{%
  \par\ifresume@first\global\resume@firstfalse\else\vspace{4pt}\fi
  \noindent{\resume@titlefont\textbf{#1}#2}\hfill{\resume@smallfont\color{secondary}#3}\par
  \protected@edef\resume@tmp{#4}%
  \ifx\resume@tmp\@empty\else\nobreak{\itshape\resume@tmp\par}\fi}

% Publication: #1 number, #2 title with closing punctuation, #3 venue, #4 authors,
% #5 award (may be empty).
\newcommand\resume@pub[5]{%
  \par\ifnum#1>1 \vspace{3pt}\fi
  \protected@edef\resume@tmp{#5}%
  {\interlinepenalty=10000
   \noindent\hangindent=2em\hangafter=1
   \makebox[2em][l]{\resume@smallfont\color{secondary}[#1]}#2 #3\newline #4%
   \ifx\resume@tmp\@empty\else\ {\color{accent}\bfseries\itshape\resume@tmp}\fi\par}}

% One-line item with right-aligned years (service, honors).
\newcommand\resume@line[2]{%
  \par\ifresume@first\global\resume@firstfalse\else\vspace{1.5pt}\fi
  {\interlinepenalty=10000 \noindent #1\hfill{\resume@smallfont\color{secondary}#2}\par}}

% Header: name, optional headline, contact block, accent bar.
\newcommand\resume@header{%
  \noindent
  \begin{minipage}[b]{0.62\textwidth}
    {\resume@namefont\resume@name\par}%
    \ifx\resume@headline\@empty\else
      \vspace{4.5pt}{\resume@headlinefont\color{headlinecolor}\resume@headline\par}%
    \fi
  \end{minipage}\hfill
  \begin{minipage}[b]{0.36\textwidth}
    \raggedleft\resume@contactfont
    \href{mailto:\resume@email}{\resume@email}\par
    \href{https://\resume@homepage}{\resume@homepage}\par
    \resume@phone\par
  \end{minipage}\par
  \vspace{9pt}%
  {\color{accent}\rule{\textwidth}{3pt}}\par}

% ---------------------------------------------------------------------------
% Data layer (expl3): profile, facts, section recording
% ---------------------------------------------------------------------------
\ExplSyntaxOn

\msg_new:nnn { resume } { unknown-key }       { Unknown~#1~key~'#2'. }
\msg_new:nnn { resume } { duplicate-fact }    { Duplicate~#1~key~'#2'. }
\msg_new:nnn { resume } { missing-field }     { The~#1~'#2'~is~missing~required~field~'#3'. }
\msg_new:nnn { resume } { unknown-field }     { The~#1~'#2'~has~unknown~field~'#3'. }
\msg_new:nnn { resume } { missing-value }     { The~#1~'#2'~has~field~'#3'~without~a~value. }
\msg_new:nnn { resume } { bad-date }          { The~#1~'#2'~has~date~'#3';~use~YYYY-MM~or~'present'. }
\msg_new:nnn { resume } { duplicate-section } { Section~'#1'~is~used~more~than~once. }
\msg_new:nnn { resume } { bad-option }
  { Unknown~\iow_char:N\\education~option~'#1';~use~'dissertation'. }

\tl_new:N \l__resume_tmp_tl
\int_new:N \l__resume_n_int

% --- Profile -------------------------------------------------------------------
\tl_new:N \g__resume_name_tl
\tl_new:N \g__resume_headline_tl
\tl_new:N \g__resume_email_tl
\tl_new:N \g__resume_homepage_tl
\tl_new:N \g__resume_phone_tl
\NewDocumentCommand \name     { m } { \tl_gset:Nn \g__resume_name_tl     {#1} }
\NewDocumentCommand \headline { m } { \tl_gset:Nn \g__resume_headline_tl {#1} }
\NewDocumentCommand \email    { m } { \tl_gset:Nn \g__resume_email_tl    {#1} }
\NewDocumentCommand \homepage { m } { \tl_gset:Nn \g__resume_homepage_tl {#1} }
\NewDocumentCommand \phone    { m } { \tl_gset:Nn \g__resume_phone_tl    {#1} }
\cs_new:cpn { resume@name }     { \tl_use:N \g__resume_name_tl }
\cs_new:cpn { resume@email }    { \tl_use:N \g__resume_email_tl }
\cs_new:cpn { resume@homepage } { \tl_use:N \g__resume_homepage_tl }
\cs_new:cpn { resume@phone }    { \tl_use:N \g__resume_phone_tl }
% \resume@headline must be a macro whose expansion can be compared with \@empty.
\cs_new_protected:Npn \__resume_sync_headline:
  { \cs_gset:cpx { resume@headline } { \exp_not:V \g__resume_headline_tl } }

% --- Facts ---------------------------------------------------------------------
% \__resume_define:nnnnn {kind} {allowed fields} {required fields} {fact key} {key=value list}
\cs_new_protected:Npn \__resume_define:nnnnn #1 #2 #3 #4 #5
  {
    \prop_if_exist:cT { g__resume_#1_#4_prop }
      { \msg_error:nnnn { resume } { duplicate-fact } {#1} {#4} }
    \prop_gclear_new:c { g__resume_#1_#4_prop }
    \keyval_parse:nnn
      { \msg_error:nnnnn { resume } { missing-value } {#1} {#4} }
      { \__resume_define_field:nnnnn {#1} {#4} {#2} }
      {#5}
    \clist_map_inline:nn {#3}
      {
        \prop_if_in:cnTF { g__resume_#1_#4_prop } {##1}
          {
            \tl_if_blank:eT { \prop_item:cn { g__resume_#1_#4_prop } {##1} }
              { \msg_error:nnnnn { resume } { missing-field } {#1} {#4} {##1} }
          }
          { \msg_error:nnnnn { resume } { missing-field } {#1} {#4} {##1} }
      }
    \seq_if_exist:cF { g__resume_#1_keys_seq } { \seq_new:c { g__resume_#1_keys_seq } }
    \seq_gput_right:cn { g__resume_#1_keys_seq } {#4}
  }
% #1 kind, #2 fact key, #3 allowed fields, #4 field, #5 value
\cs_new_protected:Npn \__resume_define_field:nnnnn #1 #2 #3 #4 #5
  {
    \clist_if_in:nnF {#3} {#4}
      { \msg_error:nnnnn { resume } { unknown-field } {#1} {#2} {#4} }
    \bool_lazy_or:nnT { \str_if_eq_p:nn {#4} { start } } { \str_if_eq_p:nn {#4} { end } }
      {
        \regex_match:nnF { \A ( \d{4} - ( 0[1-9] | 1[0-2] ) | present ) \Z } {#5}
          { \msg_error:nnnnn { resume } { bad-date } {#1} {#2} {#5} }
      }
    \prop_gput:cnn { g__resume_#1_#2_prop } {#4} {#5}
  }

\NewDocumentCommand \defrole { m m }
  {
    \__resume_define:nnnnn { role }
      { title, org, location, start, end } { title, org, start, end } {#1} {#2}
  }
\NewDocumentCommand \defproject { m m }
  {
    \__resume_define:nnnnn { project }
      { title, org, link, note, start, end } { title, start, end } {#1} {#2}
  }
\NewDocumentCommand \defdegree { m m }
  {
    \__resume_define:nnnnn { degree }
      { school, location, degree, start, end, dissertation } { school, degree, start, end } {#1} {#2}
  }
\NewDocumentCommand \defpub { m m }
  {
    \__resume_define:nnnnn { pub }
      { title, venue, authors, award } { title, venue, authors } {#1} {#2}
  }
\NewDocumentCommand \defservice { m m }
  { \__resume_define:nnnnn { service } { text, years } { text, years } {#1} {#2} }
\NewDocumentCommand \defhonor { m m }
  { \__resume_define:nnnnn { honor } { text, years } { text, years } {#1} {#2} }

\cs_new_protected:Npn \__resume_require:nn #1 #2
  {
    \prop_if_exist:cF { g__resume_#1_#2_prop }
      { \msg_error:nnnn { resume } { unknown-key } {#1} {#2} }
  }
% Field value (empty if absent).
\cs_new:Npn \__resume_field:nnn #1 #2 #3 { \prop_item:cn { g__resume_#1_#2_prop } {#3} }
% ", value" if the field is present.
\cs_new:Npn \__resume_comma_field:nnn #1 #2 #3
  {
    \tl_if_empty:eF { \__resume_field:nnn {#1} {#2} {#3} }
      { ,~ \__resume_field:nnn {#1} {#2} {#3} }
  }

% Dates: YYYY-MM -> "Aug 2024", present -> "Present". Spaces are \c_space_tl because
% a literal space after these expandable helpers can be lost.
\cs_new:Npn \__resume_date:n #1
  { \str_if_eq:nnTF {#1} { present } { Present } { \__resume_date_aux:w #1 \q_stop } }
\cs_generate_variant:Nn \__resume_date:n { e }
\cs_new:Npn \__resume_date_aux:w #1 - #2 \q_stop
  { \__resume_month:n {#2} \c_space_tl #1 }
\cs_new:Npn \__resume_month:n #1
  {
    \int_case:nn {#1}
      {
        {1}{Jan} {2}{Feb} {3}{Mar} {4}{Apr} {5}{May} {6}{Jun}
        {7}{Jul} {8}{Aug} {9}{Sep} {10}{Oct} {11}{Nov} {12}{Dec}
      }
  }
\cs_new:Npn \__resume_range:nn #1 #2
  {
    \__resume_date:e { \__resume_field:nnn {#1} {#2} { start } }
    \c_space_tl \textendash \c_space_tl
    \__resume_date:e { \__resume_field:nnn {#1} {#2} { end } }
  }

% --- Section recording and fixed-order output ----------------------------------
\clist_const:Nn \c__resume_order_clist
  { summary, experience, projects, education, publications, service, honors }
\prop_new:N \g__resume_sections_prop
\cs_new_protected:Npn \__resume_store:nn #1 #2
  {
    \prop_if_in:NnT \g__resume_sections_prop {#1}
      { \msg_error:nnn { resume } { duplicate-section } {#1} }
    \prop_gput:Nnn \g__resume_sections_prop {#1} {#2}
  }
\cs_new_protected:Npn \__resume_emit:
  {
    \clist_map_inline:Nn \c__resume_order_clist
      {
        \prop_get:NnNT \g__resume_sections_prop {##1} \l__resume_tmp_tl
          { \tl_use:N \l__resume_tmp_tl }
      }
  }

% --- Entries -------------------------------------------------------------------
\NewDocumentEnvironment { role } { m }
  {
    \__resume_require:nn { role } {#1}
    \resume@entry
      { \__resume_field:nnn { role } {#1} { title } }
      {
        \__resume_comma_field:nnn { role } {#1} { org }
        \__resume_comma_field:nnn { role } {#1} { location }
      }
      { \__resume_range:nn { role } {#1} }
      { }
    \begin{resume@bullets}
  }
  { \end{resume@bullets} }

% Builds the italic sub-line "<link without scheme> (<note>)" into #1 for project #2.
\tl_new:N \l__resume_sub_tl
\tl_new:N \l__resume_link_tl
\tl_new:N \l__resume_text_tl
\tl_new:N \l__resume_note_tl
\cs_new_protected:Npn \__resume_project_subline:Nn #1 #2
  {
    \tl_clear:N #1
    \tl_set:Ne \l__resume_link_tl { \__resume_field:nnn { project } {#2} { link } }
    \tl_if_empty:NF \l__resume_link_tl
      {
        \tl_set_eq:NN \l__resume_text_tl \l__resume_link_tl
        \regex_replace_once:nnN { \A https?:// } { } \l__resume_text_tl
        \tl_set:Ne #1
          { \exp_not:N \href { \exp_not:V \l__resume_link_tl } { \exp_not:V \l__resume_text_tl } }
        \tl_set:Ne \l__resume_note_tl { \__resume_field:nnn { project } {#2} { note } }
        \tl_if_empty:NF \l__resume_note_tl
          { \tl_put_right:Ne #1 { \c_space_tl ( \exp_not:V \l__resume_note_tl ) } }
      }
  }

\NewDocumentEnvironment { project } { m }
  {
    \__resume_require:nn { project } {#1}
    \__resume_project_subline:Nn \l__resume_sub_tl {#1}
    \resume@entry
      { \__resume_field:nnn { project } {#1} { title } }
      { \__resume_comma_field:nnn { project } {#1} { org } }
      { \__resume_range:nn { project } {#1} }
      { \l__resume_sub_tl }
    \begin{resume@bullets}
  }
  { \end{resume@bullets} }

% --- Sections ------------------------------------------------------------------
\NewDocumentEnvironment { summary } { +b }
  { \__resume_store:nn { summary } { \resume@section { Summary } {#1} } } { }
\NewDocumentEnvironment { experience } { +b }
  { \__resume_store:nn { experience } { \resume@spinesection { Experience } {#1} } } { }
\NewDocumentEnvironment { projects } { +b }
  { \__resume_store:nn { projects } { \resume@spinesection { Projects } {#1} } } { }

\NewDocumentCommand \skills { m m }
  {
    \par \vspace { 3pt }
    {
      \noindent \hangindent = 88pt \hangafter = 1
      \makebox [ 88pt ] [ l ] { \resume@smallfont \bfseries #1 } #2 \par
    }
  }

\NewDocumentCommand \education { O{} }
  {
    \tl_if_empty:nF {#1}
      {
        \str_if_eq:nnF {#1} { dissertation }
          { \msg_error:nnn { resume } { bad-option } {#1} }
      }
    \__resume_store:nn { education }
      { \resume@section { Education } { \global\resume@firsttrue \__resume_education:n {#1} } }
  }
\cs_new_protected:Npn \__resume_education:n #1
  {
    \seq_if_exist:NF \g__resume_degree_keys_seq { \seq_new:N \g__resume_degree_keys_seq }
    \seq_map_inline:Nn \g__resume_degree_keys_seq
      {
        \resume@degree
          { \__resume_field:nnn { degree } {##1} { school } }
          {
            \__resume_comma_field:nnn { degree } {##1} { location }
            \c_space_tl \textemdash \c_space_tl
            \__resume_field:nnn { degree } {##1} { degree }
          }
          { \__resume_range:nn { degree } {##1} }
          {
            \str_if_eq:nnT {#1} { dissertation }
              {
                \tl_if_empty:eF { \__resume_field:nnn { degree } {##1} { dissertation } }
                  { Dissertation: ~ \__resume_field:nnn { degree } {##1} { dissertation } }
              }
          }
      }
  }

% Authors with the profile name in bold.
\cs_generate_variant:Nn \tl_replace_all:Nnn { NV }
\cs_new_protected:Npn \__resume_authors:n #1
  {
    \tl_set:Ne \l__resume_tmp_tl {#1}
    \tl_replace_all:NVn \l__resume_tmp_tl \g__resume_name_tl
      { \textbf { \tl_use:N \g__resume_name_tl } }
    \tl_use:N \l__resume_tmp_tl
  }

\NewDocumentCommand \publications { m }
  {
    \clist_map_inline:nn {#1} { \__resume_require:nn { pub } {##1} }
    \__resume_store:nn { publications }
      { \resume@section { Publications } { \__resume_publications:n {#1} } }
  }
% Title followed by "." unless it already ends with . ? or !
\cs_new:Npn \__resume_title_punct:n #1
  {
    #1
    \str_case_e:nnF { \str_item:nn {#1} { -1 } }
      { { . } { } { ? } { } { ! } { } }
      { . }
  }
\cs_generate_variant:Nn \__resume_title_punct:n { e }
\cs_new_protected:Npn \__resume_publications:n #1
  {
    \int_zero:N \l__resume_n_int
    \clist_map_inline:nn {#1}
      {
        \int_incr:N \l__resume_n_int
        \resume@pub
          { \int_use:N \l__resume_n_int }
          { \__resume_title_punct:e { \__resume_field:nnn { pub } {##1} { title } } }
          { \__resume_field:nnn { pub } {##1} { venue } }
          { \__resume_authors:n { \__resume_field:nnn { pub } {##1} { authors } } }
          { \__resume_field:nnn { pub } {##1} { award } }
      }
  }

\cs_new_protected:Npn \__resume_lines:nn #1 #2
  {
    \global\resume@firsttrue
    \clist_map_inline:nn {#2}
      {
        \resume@line
          { \__resume_field:nnn {#1} {##1} { text } }
          { \__resume_field:nnn {#1} {##1} { years } }
      }
  }
\NewDocumentCommand \service { m }
  {
    \clist_map_inline:nn {#1} { \__resume_require:nn { service } {##1} }
    \__resume_store:nn { service }
      { \resume@section { Service } { \__resume_lines:nn { service } {#1} } }
  }
\NewDocumentCommand \honors { m }
  {
    \clist_map_inline:nn {#1} { \__resume_require:nn { honor } {##1} }
    \__resume_store:nn { honors }
      { \resume@section { Honors ~ \& ~ Awards } { \__resume_lines:nn { honor } {#1} } }
  }

% --- Document start and end ----------------------------------------------------
\AddToHook { begindocument / end }
  {
    \__resume_sync_headline:
    \hypersetup { pdftitle = { \resume@name }, pdfauthor = { \resume@name } }
    \raggedright
    \resume@header
  }
\AddToHook { enddocument } { \__resume_emit: }

\ExplSyntaxOff

% Profile and facts are shared by every resume.
\input{profile.tex}
\input{facts/roles.tex}
\input{facts/projects.tex}
\input{facts/education.tex}
\input{facts/publications.tex}
\input{facts/service.tex}
\input{facts/honors.tex}
