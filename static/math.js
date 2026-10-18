/* Math delimiters are generated from parsed math nodes, never from code blocks. */
document.querySelectorAll('.math.inline, .math.block').forEach(function (node) {
  const block = node.classList.contains('block');
  node.textContent = (block ? '\\[' : '\\(') + node.textContent + (block ? '\\]' : '\\)');
});
window.MathJax = {
  tex: {
    inlineMath: [['\\(', '\\)']], displayMath: [['\\[', '\\]']],
    packages: {'[-]': ['autoload', 'require', 'html']},
    maxMacros: 1000, maxBuffer: 20000,
  },
  svg: {fontCache: 'local'},
  options: {enableMenu: false, skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code']},
};
