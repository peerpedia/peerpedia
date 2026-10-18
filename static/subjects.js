document.querySelectorAll('[data-subject-search]').forEach(function (search) {
  const picker = search.closest('.cross-list-picker');
  search.addEventListener('input', function () {
    const query = search.value.trim().toLowerCase();
    picker.querySelectorAll('.subject-checkboxes input[type=checkbox]').forEach(function (input) {
      const label = input.closest('label');
      label.parentElement.hidden = !input.checked && !label.textContent.toLowerCase().includes(query);
    });
  });
});
