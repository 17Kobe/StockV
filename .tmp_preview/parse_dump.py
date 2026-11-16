import re
html = open('dump.html', encoding='utf-8').read()
print('total length', len(html))
crs = list(re.finditer(r'<g class="cr"', html))
print('total cr tags:', len(crs))
# print first few with surrounding 200 chars
for m in crs[:5]:
    print(html[m.start():m.start()+200])
    print('---')
