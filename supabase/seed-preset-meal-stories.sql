-- Seed: story field for all preset meals
-- Stories are short personal narratives that give context, warmth, and voice to each meal.
-- Run after all seed-preset-meals-*.sql files.

-- ── Original 10 ───────────────────────────────────────────────────────────────

UPDATE preset_meals SET story = 'Tacos are the great equalizer — cheap, quick, and deeply satisfying whether it''s Tuesday night or a backyard party. This version uses the classics: seasoned ground beef, fresh toppings, and plenty of cheese. Once you have the routine down, a full build takes under 20 minutes start to finish.'
WHERE name = 'Classic Beef Tacos';

UPDATE preset_meals SET story = 'Bolognese is the kind of sauce that rewards patience. The vegetables melt into the meat, the wine cooks off slowly, and the whole thing transforms into something that tastes like it took all day — even though it didn''t. Make a big batch on Sunday and you''ve got pasta nights covered for the week.'
WHERE name = 'Spaghetti Bolognese';

UPDATE preset_meals SET story = 'Stir fry is one of the fastest ways to get a restaurant-quality dinner on the table. The key is high heat and having everything prepped before the pan goes on the burner. Once you nail the timing, you''ll reach for this one every time the fridge is looking sparse but you still want something satisfying.'
WHERE name = 'Chicken Stir Fry';

UPDATE preset_meals SET story = 'BBQ chicken pizza came out of a Friday-night experiment — we had leftover grilled chicken, half a bottle of barbecue sauce, and a store-bought crust. It turned into a household staple overnight. The smoky-sweet combo with melted mozzarella and a handful of red onion is just impossible to argue with.'
WHERE name = 'BBQ Chicken Pizza';

UPDATE preset_meals SET story = 'There are weeks where you need dinner to be effortless without feeling like you''re phoning it in. Caesar salad with grilled chicken is that meal. Crisp romaine, salty Parmesan, crunchy croutons, and juicy chicken — it''s the kind of thing that always feels like you put more thought into it than you did.'
WHERE name = 'Caesar Salad with Grilled Chicken';

UPDATE preset_meals SET story = 'Salmon baked with lemon and dill is the meal that convinced me weeknight cooking could be genuinely good, not just functional. It takes 25 minutes, makes the kitchen smell incredible, and tastes clean and bright in a way that leaves you feeling better than when you started.'
WHERE name = 'Lemon Herb Baked Salmon';

UPDATE preset_meals SET story = 'This soup started as a way to use up a lone chicken breast and half a can of black beans. Turns out a little cumin, some canned tomatoes, and a handful of tortilla strips is all you need to turn humble pantry staples into something that tastes like effort. Now it''s a cold-weather ritual.'
WHERE name = 'Chicken Tortilla Soup';

UPDATE preset_meals SET story = 'Fried rice is the meal that proves leftovers can be better than the original. Day-old rice fries up perfectly, and a couple of eggs plus whatever vegetables you have on hand can turn it into a complete dinner in under 15 minutes. We make this every time we have rice sitting in the fridge.'
WHERE name = 'Veggie Fried Rice';

UPDATE preset_meals SET story = 'Pulled pork is the ultimate cook-once, eat-all-week situation. The shoulder braises low and slow until it''s falling apart, then you pile it onto soft slider buns with tangy coleslaw and let the BBQ sauce do the rest. It''s the kind of food people actually ask you to make for them.'
WHERE name = 'BBQ Pulled Pork Sliders';

UPDATE preset_meals SET story = 'Some of the best meals are the ones with almost nothing in them. Black bean quesadillas are fast, filling, and endlessly riffable — add whatever you have, pull out the ones you don''t, and dinner is on the table in under 15 minutes. The real trick is getting that cheese fully melted before the tortilla crisps up.'
WHERE name = 'Black Bean Quesadillas';

-- ── Meals 11–50 ───────────────────────────────────────────────────────────────

UPDATE preset_meals SET story = 'Pancakes are a weekend ritual that never gets old. Buttermilk gives them a little tang and keeps them impossibly fluffy — the kind that stack up tall and soak up maple syrup without going soggy. This recipe comes together fast enough that you can have a real breakfast on the table before anyone is fully awake.'
WHERE name = 'Buttermilk Pancakes';

UPDATE preset_meals SET story = 'French toast is the thing you make when the bread is getting a little old and you want to feel like you tried. Brioche soaked in a cinnamon-vanilla custard and fried golden in butter is not trying — it''s actually extraordinary. Dust it with powdered sugar and no one will believe you made it in 20 minutes.'
WHERE name = 'Classic French Toast';

UPDATE preset_meals SET story = 'Breakfast burritos are the ultimate meal prep move. Make a big batch on Sunday, wrap them individually, and freeze them — then all week you have a real breakfast that just needs two minutes in the microwave. Scrambled eggs, sausage, and melted cheese in a warm tortilla is hard to beat at any hour.'
WHERE name = 'Breakfast Burritos';

UPDATE preset_meals SET story = 'Avocado toast went from brunch cliché to a meal we actually eat multiple times a week. The trick is using really good sourdough — thick slices, properly toasted — and not over-seasoning the avocado so it stays fresh. A fried egg on top makes it a full meal that holds you through the morning.'
WHERE name = 'Avocado Toast with Fried Eggs';

UPDATE preset_meals SET story = 'There is no such thing as a bad homemade cheeseburger. The key is two things: a really hot pan and a generous seasoning of salt and pepper before the meat ever touches it. American cheese melted on a seared beef patty with a toasted bun is one of those pleasures that somehow never gets boring.'
WHERE name = 'Classic Cheeseburgers';

UPDATE preset_meals SET story = 'A BLT is the kind of sandwich that tastes like summer even in February. The formula is simple but the details matter — thick-cut bacon cooked to the right crispness, tomato that actually has flavor, and enough mayo that each bite is properly rich. It''s one of those sandwiches that never needs to change.'
WHERE name = 'BLT Sandwich';

UPDATE preset_meals SET story = 'The Caesar wrap is our go-to when we want something that feels lighter than a full plate of pasta but still actually satisfying. Grilled chicken, crisp romaine, crunchy croutons, and sharp Parmesan all rolled up in a flour tortilla — it''s the kind of lunch you look forward to making.'
WHERE name = 'Chicken Caesar Wrap';

UPDATE preset_meals SET story = 'Grilled cheese and tomato soup is pure comfort. There''s something almost nostalgic about pulling a golden, buttery sandwich apart and dragging it through a bowl of warm soup. We use a combination of butters and a low heat to get the bread crispy without burning, and a splash of cream in the soup makes it feel restaurant-worthy.'
WHERE name = 'Grilled Cheese and Tomato Soup';

UPDATE preset_meals SET story = 'A good chili doesn''t need much — just patience and a willingness to let it simmer long enough for everything to meld together. This one builds depth with a combination of spices and a healthy pour of broth, then just gets better the longer it sits. Make it on a Sunday and eat it all week.'
WHERE name = 'Beef Chili';

UPDATE preset_meals SET story = 'Chicken Parmesan is the Italian-American dish that everyone seems to have a version of. This one leans into the classics: a properly breaded cutlet, a bright marinara, and enough mozzarella that it bubbles and browns in the oven. It''s the kind of dinner that gets requested by name.'
WHERE name = 'Chicken Parmesan';

UPDATE preset_meals SET story = 'Shrimp tacos are what happens when you want taco night to feel a little more special without actually doing more work. Shrimp cooks in minutes, and with the right seasoning and a tangy slaw, each bite has the contrast of warm and cool, crispy and creamy. These disappear fast.'
WHERE name = 'Shrimp Tacos';

UPDATE preset_meals SET story = 'Beef and broccoli is the takeout order we started making at home after realizing it was faster and tasted better than waiting for delivery. The sauce comes together in minutes, the beef cooks quickly, and the broccoli stays bright green and slightly crisp. Serve it over rice and it''s a complete dinner with minimal cleanup.'
WHERE name = 'Beef and Broccoli';

UPDATE preset_meals SET story = 'Chicken tikka masala is the dish that turned me into someone who actually cooks. The sauce — built on tomatoes, cream, and a mix of warm spices — is rich and complex in a way that feels like it should take all day. It doesn''t. Once you have the spices on hand, this comes together in under an hour and reheats beautifully.'
WHERE name = 'Chicken Tikka Masala';

UPDATE preset_meals SET story = 'Sheet pan fajitas are the weeknight dinner we keep coming back to because cleanup is one pan and the result is genuinely good. Everything roasts together in the oven while you warm the tortillas, and the peppers and onions caramelize in a way that a skillet just can''t match. Pile it all together and dig in.'
WHERE name = 'Sheet Pan Fajitas';

UPDATE preset_meals SET story = 'Tuscan garlic chicken is one of those dinners that sounds impressive but is secretly very easy. The sauce — sun-dried tomatoes, garlic, cream, and spinach — comes together in the same pan you seared the chicken in, which means it picks up all the good flavor left behind. We make this whenever we want dinner to feel like an event.'
WHERE name = 'Tuscan Garlic Chicken';

UPDATE preset_meals SET story = 'Turkey meatballs are lighter than beef but just as satisfying when they''re cooked right — browned properly and finished in a good marinara so they stay juicy. This recipe makes a big batch, which means you''ve got meatball subs, pasta nights, or just a pot of something warm to come home to all week.'
WHERE name = 'Turkey Meatballs with Marinara';

UPDATE preset_meals SET story = 'The honey garlic glaze on this salmon is the kind of thing where you end up licking the spoon before it even hits the pan. It caramelizes under the broiler into something sticky and slightly sweet, with a savory depth from the soy and garlic underneath. It''s a 25-minute dinner that earns compliments every time.'
WHERE name = 'Honey Garlic Salmon';

UPDATE preset_meals SET story = 'Creamy tomato pasta is the meal we default to when the fridge is empty and we need something real. A can of tomatoes, a splash of cream, and some garlic become a sauce that feels far more special than its ingredient list suggests. It''s the kind of recipe you''ll make a hundred times and never get tired of.'
WHERE name = 'Creamy Tomato Pasta';

UPDATE preset_meals SET story = 'Beef enchiladas are the kind of casserole that takes care of you. Corn tortillas filled with seasoned beef, stacked in a dish, smothered in red sauce and cheese, then baked until bubbling — it''s warm, hearty, and deeply satisfying. They also freeze perfectly, which makes them one of the best things to batch cook on a weekend.'
WHERE name = 'Beef Enchiladas';

UPDATE preset_meals SET story = 'Thai peanut noodles are the dish we make when we want something that tastes exotic but takes almost no effort. The sauce comes together in a bowl — peanut butter, soy sauce, lime, ginger, garlic — and coats every noodle perfectly. It works warm or at room temperature, which makes it great for meal prep.'
WHERE name = 'Thai Peanut Noodles';

UPDATE preset_meals SET story = 'Greek chicken bowls came out of wanting something fresh and bright after too many heavy winter dinners. Juicy marinated chicken over a base of lemon rice, with cucumber, tomatoes, olives, and a generous scoop of tzatziki — it''s the bowl that makes you feel like you''re eating well without feeling like you''re missing out.'
WHERE name = 'Greek Chicken Bowls';

UPDATE preset_meals SET story = 'White chicken chili is the lighter, brighter cousin of regular chili, and it''s earned a permanent spot in our cold-weather rotation. Tender chicken, white beans, green chiles, and a creamy base come together into something that''s comforting without being heavy. Top it with sour cream and a handful of tortilla chips and dinner is done.'
WHERE name = 'White Chicken Chili';

UPDATE preset_meals SET story = 'Stuffed bell peppers feel like real cooking — the kind of meal that looks like you put in effort even when you didn''t. Colorful peppers filled with seasoned ground beef and rice, topped with melted cheese and baked until tender, make a complete dinner that even picky eaters tend to get excited about.'
WHERE name = 'Stuffed Bell Peppers';

UPDATE preset_meals SET story = 'Chicken fried rice beats takeout every time because you control the heat, the seasoning, and the ingredients. Day-old rice is the secret — fresh rice steams instead of fries. Everything comes together in one hot wok or skillet in under 15 minutes, which makes it one of the most efficient meals in the rotation.'
WHERE name = 'Chicken Fried Rice';

UPDATE preset_meals SET story = 'Teriyaki salmon bowls are the meal that makes meal prep feel worth it. Cook a batch of rice, glaze the salmon under the broiler, and add whatever vegetables you have on hand. Drizzle everything with extra teriyaki sauce and you have lunch or dinner ready in 30 minutes that tastes intentional and satisfying.'
WHERE name = 'Teriyaki Salmon Bowls';

UPDATE preset_meals SET story = 'Baked mac and cheese is the dish everyone requests and no one ever turns down. The secret is a proper béchamel base — cooked on the stove before going into the oven — and enough cheese that it stays creamy even after it bakes. That golden, slightly crispy top is the only part people fight over.'
WHERE name = 'Baked Mac and Cheese';

UPDATE preset_meals SET story = 'Carnitas tacos are the result of a very forgiving cooking method: slow-cook a pork shoulder with aromatics until it''s falling apart, then crisp the shredded meat under the broiler until the edges are slightly charred and irresistible. Load it into warm corn tortillas with cilantro and onion and a squeeze of lime. Simple as that.'
WHERE name = 'Carnitas Tacos';

UPDATE preset_meals SET story = 'Beef stroganoff is pure Eastern European comfort — tender strips of beef in a creamy mushroom sauce served over egg noodles. It''s the dish that turns a regular Tuesday into something that feels considered. The sauce comes together quickly in one pan, which means you''re never far from a bowl of something very good.'
WHERE name = 'Beef Stroganoff';

UPDATE preset_meals SET story = 'Pesto pasta with sausage is the weeknight dinner that tastes like summer regardless of the season. Store-bought basil pesto is the shortcut that makes this work — quality pesto stirred through hot pasta with browned Italian sausage and a handful of cherry tomatoes is dinner in 25 minutes, and it''s genuinely delicious.'
WHERE name = 'Pesto Pasta with Sausage';

UPDATE preset_meals SET story = 'Shakshuka is the dish that turned breakfast-for-dinner from an afterthought into something we look forward to. Eggs poached in a spiced tomato and pepper sauce sounds simple because it is — but the result is warm and deeply flavorful in a way that feels nothing like simple. Serve it with crusty bread and you''re set.'
WHERE name = 'Shakshuka';

UPDATE preset_meals SET story = 'Chicken curry is the meal that taught me spices aren''t as intimidating as they look on the shelf. Cumin, coriander, turmeric, and garam masala bloom in butter and turn into something that smells incredible and tastes even better once coconut milk brings everything together. Serve over rice and it''s one of the most satisfying things you can make.'
WHERE name = 'Chicken Curry';

UPDATE preset_meals SET story = 'Chicken piccata looks like a restaurant dish and cooks like a weeknight one. Thin chicken cutlets, pan-seared until golden, finished in a bright sauce of lemon, capers, white wine, and butter — it''s everything you want from an Italian dish without the hours. The sauce comes together while the chicken rests. Effortless and impressive.'
WHERE name = 'Chicken Piccata';

UPDATE preset_meals SET story = 'Sausage and peppers pasta is one of those meals where the sauce practically makes itself. Italian sausage renders its fat into the pan, the peppers caramelize in it, white wine deglazes everything, and the whole mixture gets tossed with pasta and a handful of Parmesan. One pan, 35 minutes, zero complaints.'
WHERE name = 'Sausage and Peppers Pasta';

UPDATE preset_meals SET story = 'Cobb salad is what happens when a salad actually commits. Crispy bacon, hard-boiled eggs, avocado, blue cheese, chicken, and tomatoes over a bed of romaine — it''s a full meal that looks great and tastes even better with a good buttermilk ranch or a sharp red wine vinaigrette. This is salad for people who like real food.'
WHERE name = 'Cobb Salad';

UPDATE preset_meals SET story = 'Pork chops get a bad reputation for being dry, but that changes when you cook them in a cast iron with a quick pan sauce at the end. Sear them hot, pull them just at 145°F, let them rest, then deglaze the pan with apple juice and a little Dijon for a sauce that makes the whole dish feel special. Simple and satisfying.'
WHERE name = 'Pork Chops with Apple Sauce';

UPDATE preset_meals SET story = 'Baked potato soup is the kind of bowl that feels like being taken care of. It''s thick, creamy, and loaded with everything good about a baked potato — cheddar, bacon, sour cream, and chives — in soup form. It''s the meal we make when the weather turns and we want something that genuinely warms you up.'
WHERE name = 'Baked Potato Soup';

UPDATE preset_meals SET story = 'Lemon garlic shrimp pasta is the dinner that looks like date-night cooking but takes 25 minutes on a Tuesday. Shrimp cooks fast, the sauce is just butter, lemon, garlic, and a splash of white wine, and linguine ties it all together into something that feels light but completely satisfying. Open a glass of wine and you''re done.'
WHERE name = 'Lemon Garlic Shrimp Pasta';

UPDATE preset_meals SET story = 'Korean beef bowls came into the rotation because we wanted something bold and a little sweet that was also genuinely fast. Ground beef cooked with soy sauce, brown sugar, garlic, ginger, and sesame oil over steamed rice, finished with green onions and sesame seeds — it''s a 20-minute dinner that punches way above its weight.'
WHERE name = 'Korean Beef Bowls';

UPDATE preset_meals SET story = 'Chicken noodle soup is the one meal everyone should know how to make from scratch. Not because it''s difficult — it''s actually very simple — but because a good homemade version is so much better than anything from a can that it''s genuinely worth it. The broth takes on flavor as the chicken poaches, and the whole thing comes together in under an hour.'
WHERE name = 'Chicken Noodle Soup';

UPDATE preset_meals SET story = 'Caprese pasta salad is what we make when we want something fresh that can sit on the table for a while without getting sad. Pasta tossed with ripe cherry tomatoes, fresh mozzarella, basil, and a good drizzle of olive oil and balsamic — it''s summer on a plate. It''s also great at room temperature, which makes it perfect for feeding a group.'
WHERE name = 'Caprese Pasta Salad';

-- ── Difficulty 4–5 (new meals) ────────────────────────────────────────────────

UPDATE preset_meals SET story = 'Chicken Marsala is the dish that made Italian-American cooking click for me. The technique is straightforward — sear, set aside, build the sauce in the same pan — but the result tastes like you spent twice as long on it. Marsala wine reduces into something almost caramel-dark, and the cream brings it back into balance. It''s elegant food that isn''t precious about itself.'
WHERE name = 'Chicken Marsala';

UPDATE preset_meals SET story = 'Making ramen from scratch is a project, but it''s also the kind of cooking that''s quietly meditative. The broth builds over a couple of hours, the marinated eggs need an overnight soak to turn that beautiful amber color, and the whole bowl comes together in layers. When you finally sit down to eat it, you understand exactly why people wait in line for a good bowl.'
WHERE name = 'Homemade Beef Ramen';

UPDATE preset_meals SET story = 'Shrimp étouffée is Louisiana cooking at its most satisfying — a dish built on patience and technique rather than rare ingredients. The roux is the whole thing. You stand at the stove and stir it past blonde, past peanut butter, to that deep mahogany that smells nutty and toasty, and then the holy trinity of onion, celery, and bell pepper goes in and you know you''re making something real.'
WHERE name = 'Shrimp Étouffée';

UPDATE preset_meals SET story = 'Pork tenderloin with a red wine pan sauce is the dinner party move that looks far more complicated than it is. The herb rub takes two minutes, the whole roast is done in under 20 in a hot oven, and the pan sauce — built from the fond and a good pour of red wine — comes together while the meat rests. It''s the kind of cooking that makes people think you went to culinary school.'
WHERE name = 'Herb-Crusted Pork Tenderloin';

UPDATE preset_meals SET story = 'Lobster bisque is the soup that turns any occasion into something special. Making it at home means you can use the shells to build a real stock, which is where all the depth comes from. Blending and straining gives it that velvety restaurant texture, and stirring real lobster meat back in at the end keeps the flavor clean and bright. Worth every step.'
WHERE name = 'Creamy Lobster Bisque';

UPDATE preset_meals SET story = 'Beef bourguignon is the benchmark recipe — the one Julia Child made famous and the one every serious home cook eventually attempts. It rewards long, patient braising with beef that melts in your mouth and a sauce so rich and complex you''ll want to eat it with a spoon. Make it on a Saturday, eat it Sunday, and it''ll be even better the second day.'
WHERE name = 'Beef Bourguignon';

UPDATE preset_meals SET story = 'Homemade gnocchi is one of those cooking experiences that completely changes your relationship with a dish. When you make the dough yourself — riced potatoes still warm from the oven, barely enough flour to hold them together — you understand what real gnocchi is supposed to feel like. Tossed in nutty brown butter with crispy sage, it''s one of the most genuinely special things you can put on a plate.'
WHERE name = 'Potato Gnocchi with Brown Butter and Sage';

UPDATE preset_meals SET story = 'Duck confit requires commitment, but it delivers something no other cooking method can: skin so shatteringly crisp it shatters when you bite through it, and meat so tender it practically falls off the bone on its own. The French green lentils underneath carry their own quiet depth — earthy, slightly nutty, brightened with mustard and vinegar. This is the kind of cooking that makes you proud.'
WHERE name = 'Duck Confit with French Green Lentils';

UPDATE preset_meals SET story = 'Making croissants at home is ambitious, and that''s the point. The lamination process — folding cold butter into dough over and over until you have dozens of paper-thin alternating layers — is the kind of technique you have to feel with your hands to understand. When they come out of the oven puffed, golden, and flaky, and you pull one apart to see those layers, it''s one of the most satisfying things baking has to offer.'
WHERE name = 'Homemade Butter Croissants';

UPDATE preset_meals SET story = 'Mole is one of the most complex sauces in the world — toasted dried chiles, charred vegetables, ground almonds, raisins, spices, and bittersweet chocolate, cooked down into something that defies easy description. It''s earthy, slightly sweet, smoky, and deeply savory all at once. Wrapped around tender chicken in enchiladas, it''s a dish that takes real effort and gives back something that no restaurant version quite matches.'
WHERE name = 'Chicken Mole Enchiladas';
